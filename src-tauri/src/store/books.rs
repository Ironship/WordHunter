use base64::Engine;
use serde_json::Value;

use super::Store;

impl Store {
    pub fn all_texts(&self) -> Result<Vec<Value>, String> {
        let inner = self.inner.lock().unwrap();
        let mut books = Vec::new();
        if !inner.books_dir.exists() {
            return Ok(books);
        }
        for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = entry.path().join("metadata.json");
            if meta.is_file() {
                if let Ok(text) = std::fs::read_to_string(meta) {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        books.push(value);
                    }
                }
            }
        }
        Ok(books)
    }

    pub fn upsert_text(&self, text: &Value) -> Result<(), String> {
        let id = text
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "text.id required".to_string())?;
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let book_dir = inner.books_dir.join(safe_id);
        std::fs::create_dir_all(&book_dir).map_err(|e| e.to_string())?;

        let mut meta = text.clone();
        if let Some(obj) = meta.as_object_mut() {
            if let Some(raw_text) = obj
                .remove("text")
                .and_then(|value| value.as_str().map(str::to_string))
            {
                std::fs::write(book_dir.join("text.txt"), raw_text)
                    .map_err(|e| e.to_string())?;
            }
        }

        std::fs::write(
            book_dir.join("metadata.json"),
            serde_json::to_vec(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn get_text_content(&self, id: &str) -> Result<String, String> {
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let path = inner.books_dir.join(safe_id).join("text.txt");
        if path.exists() {
            std::fs::read_to_string(path).map_err(|e| e.to_string())
        } else {
            Ok(String::new())
        }
    }

    pub fn delete_text(&self, id: &str) -> Result<(), String> {
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let path = inner.books_dir.join(safe_id);
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn sync_texts(&self, texts: &[Value]) -> Result<(), String> {
        for text in texts {
            self.upsert_text(text)?;
        }

        let requested: std::collections::HashSet<String> = texts
            .iter()
            .filter_map(|text| text.get("id").and_then(Value::as_str))
            .filter_map(|id| crate::paths::sanitize_id(id).ok())
            .collect();
        let inner = self.inner.lock().unwrap();
        if inner.books_dir.exists() {
            for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !requested.contains(&name) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
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
        let safe_book = crate::paths::sanitize_id(book_id)?;
        let safe_img = crate::paths::sanitize_id(img_name)?;
        let inner = self.inner.lock().unwrap();
        let img_dir = inner.books_dir.join(safe_book).join("images");
        std::fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
        std::fs::write(img_dir.join(safe_img), data).map_err(|e| e.to_string())
    }

    pub fn save_book_image_bytes(
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
