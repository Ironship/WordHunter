pub mod books;
pub(crate) mod durable;
pub(crate) mod media_assets;
pub mod record_files;
pub mod snapshot;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

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
    pub books_dir: PathBuf,
}

impl Store {
    pub fn new(app_name: &str) -> Result<Self, String> {
        let dir = crate::paths::data_dir(app_name)?;
        let books_dir = dir.join("books");
        std::fs::create_dir_all(&books_dir).map_err(|e| e.to_string())?;
        let store = Self {
            inner: Mutex::new(StoreInner { dir, books_dir }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: crate::paths::device_id(app_name)?,
        };
        #[cfg(not(target_os = "android"))]
        {
            store.recover_pending_save()?;
            store.discard_abandoned_book_imports()?;
        }
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
        self.discard_abandoned_book_imports()?;
        let target_has_data = has_wordhunter_data(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        validate_data_dir_layout(&dir)?;
        if !target_has_data {
            copy_data_dir(&current, &dir)?;
        } else {
            merge_data_dir(&current, &dir, self.device_id())?;
        }
        let previous_inner = self.inner.lock().unwrap().clone();
        let previous_base_records = self.base_records.lock().unwrap().clone();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.books_dir = dir.join("books");
            inner.dir = dir.clone();
        }
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(dir.join("books")).map_err(|e| e.to_string())?;
            self.recover_pending_save()?;
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
}

#[cfg(not(target_os = "android"))]
fn copy_data_dir(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    for name in ["books", "argos-packages", "records"] {
        let source = from.join(name);
        if source.is_dir() {
            copy_tree(&source, &to.join(name))?;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn merge_data_dir(
    from: &std::path::Path,
    to: &std::path::Path,
    device_id: &str,
) -> Result<(), String> {
    let source_records = record_files::load_records(from)?;
    let target_records = record_files::load_records(to)?;
    let merged = record_files::merge_records(
        &BTreeMap::new(),
        source_records,
        target_records,
        device_id,
        record_files::now_millis(),
    );
    record_files::write_records(to, &merged.records)?;
    record_files::write_conflicts(to, &merged.conflicts)?;
    media_assets::merge_book_assets_into(from, to, device_id)?;
    let source_packages = from.join("argos-packages");
    if source_packages.is_dir() {
        copy_tree(&source_packages, &to.join("argos-packages"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn has_wordhunter_data(dir: &std::path::Path) -> bool {
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
fn validate_data_dir_layout(dir: &std::path::Path) -> Result<(), String> {
    for name in ["books", "argos-packages"] {
        let path = dir.join(name);
        if path.exists() && !path.is_dir() {
            return Err(format!(
                "configured data folder has a file where WordHunter needs a folder: {}",
                path.display()
            ));
        }
    }
    record_files::validate_records_layout(dir)
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

    use super::{Store, StoreInner, copy_data_dir, media_assets, merge_data_dir, record_files};

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
        Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: device_id.to_string(),
        }
    }

    fn profile_payload(word: &str, translation: &str) -> Value {
        let mut vocab = Map::new();
        vocab.insert(
            word.to_string(),
            json!({ "word": word, "translation": translation, "status": "learning" }),
        );
        json!({
            "schemaVersion": 2,
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
        std::fs::create_dir_all(source.path().join("books/one/images")).unwrap();
        std::fs::write(source.path().join("books/one/images/cover.jpg"), "cover").unwrap();
        std::fs::create_dir_all(source.path().join("argos-packages")).unwrap();
        std::fs::write(source.path().join("argos-packages/model.bin"), "model").unwrap();
        std::fs::create_dir_all(source.path().join("records/v1/prefs")).unwrap();
        std::fs::write(source.path().join("records/v1/prefs/pref.json"), "{}").unwrap();

        copy_data_dir(source.path(), target.path()).unwrap();

        assert!(target.path().join("books/one/images/cover.jpg").is_file());
        assert_eq!(
            std::fs::read_to_string(target.path().join("argos-packages/model.bin")).unwrap(),
            "model"
        );
        assert!(target.path().join("records/v1/prefs/pref.json").is_file());
    }

    #[test]
    fn relocation_merges_existing_target_without_overwriting_it() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
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
        let snapshot = store.snapshot_unacknowledged();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "local"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["chmura"]["translation"],
            "cloud"
        );
        store
            .bulk_save(profile_payload("lokal", "local-after-relocation"))
            .unwrap();
        assert_eq!(
            store.snapshot()["vocab"]["de"]["vocab"]["chmura"]["translation"],
            "cloud"
        );
    }

    #[test]
    fn relocation_into_existing_target_keeps_source_text_and_media() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let _appdata = AppDataGuard::set(appdata.path());
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let store = store_at(&source, "local-device");
        store
            .upsert_text(&json!({
                "id": "de-custom-source",
                "title": "Source text",
                "text": "Full source-only body"
            }))
            .unwrap();
        store
            .save_book_image_bytes("de-custom-source", "cover.png", b"source-cover")
            .unwrap();
        let target_records = record_files::payload_to_records(
            &profile_payload("chmura", "cloud"),
            "cloud-device",
            1,
        );
        record_files::write_records(target.path(), &target_records).unwrap();

        store.relocate(target.path().to_path_buf()).unwrap();

        assert_eq!(
            store.get_text_content("de-custom-source").unwrap(),
            "Full source-only body"
        );
        assert_eq!(
            std::fs::read(
                store
                    .book_image_path("de-custom-source", "cover.png")
                    .unwrap()
            )
            .unwrap(),
            b"source-cover"
        );
        assert_eq!(
            store.snapshot()["vocab"]["de"]["vocab"]["chmura"]["translation"],
            "cloud"
        );
    }

    #[test]
    fn relocation_media_merge_never_applies_target_tombstones_to_source() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source_store = store_at(&source, "source-device");
        let target_store = store_at(&target, "target-device");
        source_store
            .save_book_image_bytes("de-custom-source", "cover.png", b"source-cover")
            .unwrap();
        target_store
            .save_book_image_bytes("de-custom-source", "cover.png", b"old-cover")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        media_assets::tombstone_book_assets(target.path(), "de-custom-source", "target-device")
            .unwrap();

        merge_data_dir(source.path(), target.path(), "source-device").unwrap();

        assert!(
            source
                .path()
                .join("books/de-custom-source/images/cover.png")
                .is_file()
        );
        assert!(
            !target
                .path()
                .join("books/de-custom-source/images/cover.png")
                .exists()
        );
    }

    #[test]
    fn relocation_does_not_persist_target_until_it_is_usable() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let _appdata = AppDataGuard::set(appdata.path());
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let store = store_at(&source, "local-device");
        std::fs::write(target.path().join("records"), "not a dir").unwrap();

        assert!(store.relocate(target.path().to_path_buf()).is_err());

        assert_eq!(store.dir(), source.path().to_path_buf());
        assert!(!appdata.path().join("WordHunter-data-dir.txt").exists());
    }

    #[test]
    fn redirected_missing_data_dir_errors_instead_of_creating_empty_folder() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
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
}
