use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;

use super::Store;
use super::record_files;

const RECORD: &str = "book.json";

impl Store {
    pub fn all_texts(&self) -> Result<Vec<Value>, String> {
        let inner = self.inner.lock().unwrap();
        let mut books = Vec::new();
        if !inner.books_dir.exists() {
            return Ok(books);
        }
        for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.path().is_dir() {
                continue;
            }
            match read_book(&entry.path()) {
                Ok(Some((metadata, _))) => books.push(metadata),
                Ok(None) => {}
                Err(e) => {
                    return Err(format!(
                        "book {} is unreadable: {e}",
                        entry.path().display()
                    ));
                }
            }
        }
        Ok(books)
    }

    pub fn upsert_text(&self, text: &Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.upsert_text_unlocked(text)
    }

    pub(crate) fn upsert_text_unlocked(&self, text: &Value) -> Result<(), String> {
        let id = text
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "text.id required".to_string())?;
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let book_dir = inner.books_dir.join(safe_id);
        std::fs::create_dir_all(&book_dir).map_err(|e| e.to_string())?;

        let (mut metadata, mut content) =
            read_book(&book_dir)?.unwrap_or((json!({}), String::new()));
        let mut incoming = text.clone();
        if let Some(obj) = incoming.as_object_mut()
            && let Some(raw) = obj
                .remove("text")
                .and_then(|value| value.as_str().map(str::to_owned))
        {
            content = raw;
        }
        let target = metadata
            .as_object_mut()
            .ok_or_else(|| "stored book metadata is not an object".to_string())?;
        for (key, value) in incoming
            .as_object()
            .ok_or_else(|| "text must be an object".to_string())?
        {
            target.insert(key.clone(), value.clone());
        }
        let record = json!({ "metadata": metadata, "text": content });
        atomic_json(&book_dir.join(RECORD), &record)?;
        let mut sync_text = text.clone();
        if let Some(obj) = sync_text.as_object_mut() {
            obj.entry("text".to_string())
                .or_insert_with(|| Value::String(content));
        }
        record_files::upsert_text_record(&inner.dir, &sync_text, self.device_id())
    }

    pub fn get_text_content(&self, id: &str) -> Result<String, String> {
        if let Some(text) = record_files::text_content(&self.dir(), id)? {
            return Ok(text);
        }
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        Ok(read_book(&inner.books_dir.join(safe_id))?
            .map(|(_, text)| text)
            .unwrap_or_default())
    }

    pub fn delete_text(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.delete_text_unlocked(id)
    }

    pub(crate) fn delete_text_unlocked(&self, id: &str) -> Result<(), String> {
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let path = inner.books_dir.join(safe_id);
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
        record_files::delete_text_record(&inner.dir, id, self.device_id())?;
        Ok(())
    }

    pub(crate) fn sync_texts(&self, texts: &[Value]) -> Result<(), String> {
        for text in texts {
            self.upsert_text_unlocked(text)?;
        }
        Ok(())
    }

    pub fn save_book_image(&self, payload: &Value) -> Result<(), String> {
        let book_id = payload
            .get("book_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "book_id required".to_string())?;
        let img_name = payload
            .get("img_name")
            .and_then(Value::as_str)
            .ok_or_else(|| "img_name required".to_string())?;
        let data_url = payload
            .get("base64_data")
            .and_then(Value::as_str)
            .ok_or_else(|| "base64_data required".to_string())?;
        let encoded = data_url
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(data_url);
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| e.to_string())?;
        let _guard = self.lock_writes()?;
        self.save_book_image_bytes_unlocked(book_id, img_name, &data)
    }

    #[cfg(any(not(target_os = "android"), test))]
    pub fn save_book_image_bytes(
        &self,
        book_id: &str,
        img_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.save_book_image_bytes_unlocked(book_id, img_name, data)
    }

    pub(crate) fn save_book_image_bytes_unlocked(
        &self,
        book_id: &str,
        img_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let safe_book = crate::paths::sanitize_id(book_id)?;
        let safe_img = crate::paths::sanitize_id(img_name)?;
        let inner = self.inner.lock().unwrap();
        let img_dir = inner.books_dir.join(safe_book).join("images");
        std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
        std::fs::write(img_dir.join(safe_img), data).map_err(|e| e.to_string())
    }

    pub fn book_image_path(&self, book: &str, img: &str) -> Result<std::path::PathBuf, String> {
        let safe_book = crate::paths::sanitize_id(book)?;
        let safe_img = crate::paths::sanitize_id(img)?;
        let inner = self.inner.lock().unwrap();
        Ok(inner
            .books_dir
            .join(safe_book)
            .join("images")
            .join(safe_img))
    }
}

fn read_book(dir: &std::path::Path) -> Result<Option<(Value, String)>, String> {
    let record = dir.join(RECORD);
    if record.exists() || record.with_extension("bak").exists() {
        return parse_record(&record)
            .or_else(|_| parse_record(&record.with_extension("bak")))
            .map(Some);
    }
    let metadata = dir.join("metadata.json");
    if !metadata.exists() {
        return Ok(None);
    }
    let metadata = serde_json::from_slice(&std::fs::read(metadata).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(dir.join("text.txt")).unwrap_or_default();
    Ok(Some((metadata, text)))
}

fn parse_record(path: &std::path::Path) -> Result<(Value, String), String> {
    let value: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let metadata = value
        .get("metadata")
        .cloned()
        .filter(Value::is_object)
        .ok_or_else(|| "record metadata is missing".to_string())?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "record text is missing".to_string())?
        .to_string();
    Ok((metadata, text))
}

fn atomic_json(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::copy(path, path.with_extension("bak")).map_err(|e| e.to_string())?;
    }
    replace_with_tmp(&tmp, path)
}

fn replace_with_tmp(tmp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(tmp, path).is_ok() {
        return Ok(());
    }
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("failed to replace locked book {}: {e}", path.display()))?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use serde_json::json;

    use crate::store::{Store, StoreInner};

    #[test]
    fn book_record_keeps_text_and_metadata_together() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                db_path: dir.path().join("store.sqlite"),
                vocab_path: dir.path().join("vocab.json"),
                books_dir: books_dir.clone(),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };

        store
            .upsert_text(&json!({ "id": "book", "title": "First", "text": "content" }))
            .unwrap();
        store
            .upsert_text(&json!({ "id": "book", "title": "Renamed" }))
            .unwrap();

        assert_eq!(store.get_text_content("book").unwrap(), "content");
        assert_eq!(store.all_texts().unwrap()[0]["title"], "Renamed");
        assert!(books_dir.join("book").join("book.json").is_file());
    }

    #[test]
    fn language_prefixed_book_ids_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
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
            device_id: "test-device".to_string(),
        };

        store
            .upsert_text(&json!({ "id": "de-custom-home", "text": "Haus" }))
            .unwrap();
        store
            .upsert_text(&json!({ "id": "fr-custom-home", "text": "Maison" }))
            .unwrap();

        assert_eq!(store.get_text_content("de-custom-home").unwrap(), "Haus");
        assert_eq!(store.get_text_content("fr-custom-home").unwrap(), "Maison");
    }

    #[test]
    fn book_record_recovers_from_backup_when_primary_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let book_dir = dir.path().join("book");
        std::fs::create_dir_all(&book_dir).unwrap();
        std::fs::write(
            book_dir.join("book.bak"),
            r#"{"metadata":{"id":"book","title":"Backup"},"text":"safe text"}"#,
        )
        .unwrap();

        let (metadata, text) = super::read_book(&book_dir).unwrap().unwrap();

        assert_eq!(metadata["title"], "Backup");
        assert_eq!(text, "safe text");
    }
}
