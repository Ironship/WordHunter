use std::path::Path;

use serde_json::{json, Value};

use super::Store;

impl Store {
    pub fn load_vocab(&self) -> Result<Value, String> {
        let inner = self.inner.lock().unwrap();
        if let Some(vocab) = read_valid_json(&inner.vocab_path) {
            return Ok(vocab);
        }

        let tmp = inner.vocab_path.with_extension("tmp");
        if let Some(vocab) = read_valid_json(&tmp) {
            return Ok(vocab);
        }

        let backup = inner.vocab_path.with_extension("bak");
        if let Some(vocab) = read_valid_json(&backup) {
            return Ok(vocab);
        }

        if inner.vocab_path.exists() {
            return Err("vocab file is unreadable and no recovery copy is valid".to_string());
        }
        Ok(json!({}))
    }

    pub(crate) fn save_vocab(&self, vocab: &Value) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let tmp = inner.vocab_path.with_extension("tmp");
        let backup = inner.vocab_path.with_extension("bak");
        std::fs::write(
            &tmp,
            serde_json::to_string_pretty(vocab).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        if inner.vocab_path.exists() {
            if let Err(e) = std::fs::copy(&inner.vocab_path, &backup) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("failed to back up existing vocab: {e}"));
            }
        }

        replace_with_tmp(&tmp, &inner.vocab_path)
    }
}

fn replace_with_tmp(tmp: &Path, path: &Path) -> Result<(), String> {
    if std::fs::rename(tmp, path).is_ok() {
        return Ok(());
    }
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("failed to replace locked vocab {}: {e}", path.display()))?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn read_valid_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use serde_json::{json, Value};

    use crate::store::{Store, StoreInner};

    fn store_at(dir: &tempfile::TempDir) -> Store {
        Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                db_path: dir.path().join("store.sqlite"),
                vocab_path: dir.path().join("vocab.json"),
                books_dir: dir.path().join("books"),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        }
    }

    #[test]
    fn load_vocab_recovers_from_backup() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(dir.path().join("vocab.json"), "{").unwrap();
        std::fs::write(
            dir.path().join("vocab.bak"),
            r#"{"hello":{"status":"known"}}"#,
        )
        .unwrap();

        assert_eq!(
            store.load_vocab().unwrap(),
            json!({ "hello": { "status": "known" } })
        );
    }

    #[test]
    fn load_vocab_recovers_from_backup_when_primary_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            dir.path().join("vocab.bak"),
            r#"{"hello":{"status":"known"}}"#,
        )
        .unwrap();

        assert_eq!(
            store.load_vocab().unwrap(),
            json!({ "hello": { "status": "known" } })
        );
    }

    #[test]
    fn save_vocab_keeps_the_previous_version_as_backup() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            dir.path().join("vocab.json"),
            r#"{"hello":{"status":"new"}}"#,
        )
        .unwrap();

        store
            .save_vocab(&json!({ "hello": { "status": "known" } }))
            .unwrap();

        let backup = std::fs::read_to_string(dir.path().join("vocab.bak")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&backup).unwrap(),
            json!({ "hello": { "status": "new" } })
        );
    }
}
