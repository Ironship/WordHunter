pub mod books;
pub mod db;
pub mod snapshot;
pub mod vocab_file;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

pub struct Store {
    inner: Mutex<StoreInner>,
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
        };
        store.init_schema()?;
        Ok(store)
    }

    pub fn dir(&self) -> PathBuf {
        self.inner.lock().unwrap().dir.clone()
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
