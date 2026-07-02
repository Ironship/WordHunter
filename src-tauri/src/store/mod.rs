pub mod books;
pub mod db;
pub mod record_files;
pub mod snapshot;
pub mod vocab_file;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

const DB_SCHEMA_VERSION: u32 = 2;

pub struct Store {
    inner: Mutex<StoreInner>,
    // Global save lock; shard only if saves become a bottleneck.
    write_lock: Mutex<()>,
    base_records: Mutex<record_files::Fingerprints>,
    device_id: String,
}

#[derive(Clone)]
struct StoreInner {
    pub dir: PathBuf,
    pub db_path: PathBuf,
    pub vocab_path: PathBuf,
    pub books_dir: PathBuf,
}

impl Store {
    pub fn new(app_name: &str) -> Result<Self, String> {
        let dir = crate::paths::data_dir(app_name)?;
        let db_path = dir.join("store.sqlite");
        let vocab_path = dir.join("vocab.json");
        let books_dir = dir.join("books");
        std::fs::create_dir_all(&books_dir).map_err(|e| e.to_string())?;
        let store = Self {
            inner: Mutex::new(StoreInner {
                dir,
                db_path,
                vocab_path,
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: crate::paths::device_id(app_name)?,
        };
        store.init_schema()?;
        #[cfg(not(target_os = "android"))]
        store.recover_pending_save()?;
        // Snapshot refreshes records on first load; do not block Android WebView creation here.
        Ok(store)
    }

    pub fn dir(&self) -> PathBuf {
        self.inner.lock().unwrap().dir.clone()
    }

    pub(crate) fn device_id(&self) -> &str {
        &self.device_id
    }

    pub(crate) fn lock_writes(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub fn relocate(&self, dir: PathBuf) -> Result<PathBuf, String> {
        let _write_guard = self.lock_writes()?;
        let current = self.dir();
        if current == dir {
            return Ok(current);
        }
        let current_payload = self.snapshot_unlocked();
        let target_has_data = has_wordhunter_data(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if !target_has_data {
            copy_data_dir(&current, &dir)?;
        }
        let previous_inner = self.inner.lock().unwrap().clone();
        let previous_base_records = self.base_records.lock().unwrap().clone();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.db_path = dir.join("store.sqlite");
            inner.vocab_path = dir.join("vocab.json");
            inner.books_dir = dir.join("books");
            inner.dir = dir.clone();
        }
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(dir.join("books")).map_err(|e| e.to_string())?;
            self.init_schema()?;
            self.recover_pending_save()?;
            if target_has_data {
                self.base_records.lock().unwrap().clear();
                self.commit_bulk_save(&current_payload)?;
            } else {
                self.seed_or_refresh_records()?;
            }
            crate::paths::set_data_dir(crate::APP_NAME, &dir)?;
            Ok(())
        })();
        if let Err(error) = result {
            let mut inner = self.inner.lock().unwrap();
            *inner = previous_inner;
            *self.base_records.lock().unwrap() = previous_base_records;
            return Err(error);
        }
        Ok(dir)
    }

    fn conn(inner: &StoreInner) -> Result<Connection, String> {
        Connection::open(&inner.db_path).map_err(|e| e.to_string())
    }

    fn init_schema(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let conn = Self::conn(&inner)?;
        let current_version = conn
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .map_err(|e| e.to_string())?;
        if current_version > DB_SCHEMA_VERSION {
            return Err(format!(
                "unsupported database schema version {current_version}; this build supports {DB_SCHEMA_VERSION}"
            ));
        }
        // WAL improves concurrency between reads/writes; busy_timeout avoids
        // "database is locked" errors under brief contention.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
            .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS hidden_books (id TEXT PRIMARY KEY)",
            [],
        )
        .map_err(|e| e.to_string())?;
        if current_version < DB_SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version = {DB_SCHEMA_VERSION};"))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn db_schema_version(&self) -> Result<u32, String> {
        let inner = self.inner.lock().unwrap();
        let conn = Self::conn(&inner)?;
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "android"))]
fn copy_data_dir(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    for name in [
        "store.sqlite",
        "store.sqlite-wal",
        "store.sqlite-shm",
        "vocab.json",
        "vocab.bak",
    ] {
        let source = from.join(name);
        if source.is_file() {
            std::fs::copy(&source, to.join(name)).map_err(|e| e.to_string())?;
        }
    }
    for name in ["books", "argos-packages", "records"] {
        let source = from.join(name);
        if source.is_dir() {
            copy_tree(&source, &to.join(name))?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn has_wordhunter_data(dir: &std::path::Path) -> bool {
    if ["store.sqlite", "vocab.json", "vocab.bak"]
        .iter()
        .any(|name| dir.join(name).exists())
    {
        return true;
    }
    if record_files::has_records(dir) {
        return true;
    }
    ["books", "argos-packages"].iter().any(|name| {
        let path = dir.join(name);
        path.is_dir()
            && std::fs::read_dir(path)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
    })
}

#[cfg(not(target_os = "android"))]
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::sync::Mutex;

    use serde_json::{Map, Value, json};

    use super::{Store, StoreInner, copy_data_dir, record_files};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct AppDataGuard(Option<OsString>);

    impl AppDataGuard {
        fn set(path: &std::path::Path) -> Self {
            let previous = std::env::var_os("APPDATA");
            // SAFETY: tests hold ENV_LOCK while overriding process env.
            unsafe { std::env::set_var("APPDATA", path) };
            Self(previous)
        }
    }

    impl Drop for AppDataGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.0.take() {
                // SAFETY: tests hold ENV_LOCK while overriding process env.
                unsafe { std::env::set_var("APPDATA", previous) };
            } else {
                // SAFETY: tests hold ENV_LOCK while overriding process env.
                unsafe { std::env::remove_var("APPDATA") };
            }
        }
    }

    fn store_at(dir: &tempfile::TempDir, device_id: &str) -> Store {
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                db_path: dir.path().join("store.sqlite"),
                vocab_path: dir.path().join("vocab.json"),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: device_id.to_string(),
        };
        store.init_schema().unwrap();
        store
    }

    fn profile_payload(word: &str, translation: &str) -> Value {
        let mut vocab = Map::new();
        vocab.insert(
            word.to_string(),
            json!({ "word": word, "translation": translation, "status": "learning" }),
        );
        json!({
            "texts": [],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": {
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": vocab
                }
            }
        })
    }

    #[test]
    fn relocation_copies_state_and_book_files() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("vocab.json"), "{}").unwrap();
        std::fs::create_dir_all(source.path().join("books/one")).unwrap();
        std::fs::write(source.path().join("books/one/text.txt"), "hello").unwrap();
        std::fs::create_dir_all(source.path().join("argos-packages")).unwrap();
        std::fs::write(source.path().join("argos-packages/model.bin"), "model").unwrap();
        std::fs::create_dir_all(source.path().join("records/v1/prefs")).unwrap();
        std::fs::write(source.path().join("records/v1/prefs/pref.json"), "{}").unwrap();

        copy_data_dir(source.path(), target.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.path().join("vocab.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            std::fs::read_to_string(target.path().join("books/one/text.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(target.path().join("argos-packages/model.bin")).unwrap(),
            "model"
        );
        assert!(target.path().join("records/v1/prefs/pref.json").is_file());
    }

    #[test]
    fn relocation_merges_existing_target_without_overwriting_it() {
        let _lock = ENV_LOCK.lock().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let _appdata = AppDataGuard::set(appdata.path());
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let store = store_at(&source, "local-device");
        store.bulk_save(profile_payload("lokal", "local")).unwrap();

        let target_payload = profile_payload("chmura", "cloud");
        let target_records = record_files::payload_to_records(&target_payload, "cloud-device", 1);
        record_files::write_records(target.path(), &target_records).unwrap();

        store.relocate(target.path().to_path_buf()).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "local"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["chmura"]["translation"],
            "cloud"
        );
    }

    #[test]
    fn relocation_does_not_persist_target_until_it_is_usable() {
        let _lock = ENV_LOCK.lock().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let _appdata = AppDataGuard::set(appdata.path());
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let store = store_at(&source, "local-device");
        std::fs::create_dir(target.path().join("store.sqlite")).unwrap();

        assert!(store.relocate(target.path().to_path_buf()).is_err());

        assert_eq!(store.dir(), source.path().to_path_buf());
        assert!(!appdata.path().join("WordHunter-data-dir.txt").exists());
    }

    #[test]
    fn redirected_missing_data_dir_errors_instead_of_creating_empty_folder() {
        let _lock = ENV_LOCK.lock().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let _appdata = AppDataGuard::set(appdata.path());
        let missing = appdata.path().join("missing-cloud-folder");
        std::fs::write(
            appdata.path().join("WordHunter-data-dir.txt"),
            missing.to_string_lossy().as_bytes(),
        )
        .unwrap();

        let error = crate::paths::data_dir("WordHunter").unwrap_err();

        assert!(error.contains("configured data folder is missing"));
        assert!(!missing.exists());
    }

    #[test]
    fn init_schema_sets_sqlite_user_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir, "local-device");

        assert_eq!(store.db_schema_version().unwrap(), super::DB_SCHEMA_VERSION);
    }

    #[test]
    fn init_schema_rejects_newer_sqlite_user_version() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let db_path = dir.path().join("store.sqlite");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA user_version = 999;").unwrap();
        drop(conn);
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                db_path,
                vocab_path: dir.path().join("vocab.json"),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "local-device".to_string(),
        };

        let error = store.init_schema().unwrap_err();

        assert!(error.contains("unsupported database schema version 999"));
        assert_eq!(store.db_schema_version().unwrap(), 999);
    }
}
