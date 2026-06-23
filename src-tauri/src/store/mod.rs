pub mod books;
pub mod db;
pub mod snapshot;
pub mod vocab_file;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

pub struct Store {
    inner: Mutex<StoreInner>,
    // ponytail: global save lock; shard only if saves become a bottleneck.
    write_lock: Mutex<()>,
}

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
        };
        store.init_schema()?;
        store.recover_pending_save()?;
        Ok(store)
    }

    pub fn dir(&self) -> PathBuf {
        self.inner.lock().unwrap().dir.clone()
    }

    pub fn relocate(&self, dir: PathBuf) -> Result<PathBuf, String> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())?;
        let current = self.dir();
        if current == dir {
            return Ok(current);
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        copy_data_dir(&current, &dir)?;
        crate::paths::set_data_dir(crate::APP_NAME, &dir)?;
        let mut inner = self.inner.lock().unwrap();
        inner.db_path = dir.join("store.sqlite");
        inner.vocab_path = dir.join("vocab.json");
        inner.books_dir = dir.join("books");
        inner.dir = dir.clone();
        drop(inner);
        self.init_schema()?;
        Ok(dir)
    }

    fn conn(inner: &StoreInner) -> Result<Connection, String> {
        Connection::open(&inner.db_path).map_err(|e| e.to_string())
    }

    fn init_schema(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let conn = Self::conn(&inner)?;
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
        Ok(())
    }
}

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
    for name in ["books", "argos-packages"] {
        let source = from.join(name);
        if source.is_dir() {
            copy_tree(&source, &to.join(name))?;
        }
    }
    Ok(())
}

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
    use super::copy_data_dir;

    #[test]
    fn relocation_copies_state_and_book_files() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("vocab.json"), "{}").unwrap();
        std::fs::create_dir_all(source.path().join("books/one")).unwrap();
        std::fs::write(source.path().join("books/one/text.txt"), "hello").unwrap();
        std::fs::create_dir_all(source.path().join("argos-packages")).unwrap();
        std::fs::write(source.path().join("argos-packages/model.bin"), "model").unwrap();

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
    }
}
