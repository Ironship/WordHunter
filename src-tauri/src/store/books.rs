use base64::Engine;
use serde_json::{Map, Value};

use super::Store;
use super::durable;
use super::media_assets;
use super::record_files;

impl Store {
    pub(crate) fn discard_abandoned_book_imports(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let mut pending_books = Vec::new();
        if inner.books_dir.is_dir() {
            for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    continue;
                }
                let book_dir = entry.path();
                let marker = book_dir.join(media_assets::IMPORT_PENDING_MARKER);
                if !marker.is_file() {
                    continue;
                }
                let Some(book_id) = entry.file_name().to_str().map(str::to_owned) else {
                    return Err("pending PDF import id is not UTF-8".to_string());
                };
                pending_books.push((book_id, book_dir, marker));
            }
        }
        if !pending_books.is_empty() {
            let records = record_files::load_records(&inner.dir)?;
            for (book_id, book_dir, marker) in pending_books {
                let has_live_record = records
                    .get(&format!("text:{book_id}"))
                    .is_some_and(|record| record.deleted_at.is_none());
                if has_live_record {
                    media_assets::finalize_imported_book_assets(
                        &inner.dir,
                        &book_id,
                        self.device_id(),
                    )?;
                    durable::remove_file_if_exists(&marker)?;
                } else {
                    std::fs::remove_dir_all(&book_dir).map_err(|e| e.to_string())?;
                    durable::sync_parent(&book_dir)?;
                    media_assets::discard_imported_book_assets(
                        &inner.dir,
                        &book_id,
                        self.device_id(),
                    )?;
                }
            }
        }
        let path = inner.dir.join("ocr-import-staging");
        if path.exists() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            durable::sync_parent(&path)?;
        }
        Ok(())
    }

    pub fn upsert_text(&self, text: &Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        self.upsert_text_unlocked(text)
    }

    pub(crate) fn upsert_text_unlocked(&self, text: &Value) -> Result<(), String> {
        let id = text
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "text.id required".to_string())?;
        crate::paths::sanitize_id(id)?;
        let dir = self.dir();
        let mut metadata = existing_text_data(&dir, id)?;
        let mut content = metadata
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
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
        target.insert("id".to_string(), Value::String(id.to_string()));
        target.insert("text".to_string(), Value::String(content));
        validate_pdf_page_assets(&dir, id, &metadata)?;
        record_files::upsert_text_record(&dir, &metadata, self.device_id())?;
        self.complete_pending_book_import(&dir, id)?;
        Ok(())
    }

    pub fn get_text_content(&self, id: &str) -> Result<String, String> {
        crate::paths::sanitize_id(id)?;
        Ok(record_files::text_content(&self.dir(), id)?.unwrap_or_default())
    }

    pub fn delete_text(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        self.delete_text_unlocked(id)
    }

    pub(crate) fn delete_text_unlocked(&self, id: &str) -> Result<(), String> {
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let path = inner.books_dir.join(&safe_id);
        media_assets::tombstone_book_assets(&inner.dir, &safe_id, self.device_id())?;
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
            durable::sync_parent(&inner.books_dir)?;
        }
        record_files::delete_text_record(&inner.dir, id, self.device_id())?;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn discard_book_import_assets(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let path = inner.dir.join("ocr-import-staging").join(&safe_id);
        if path.exists() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            durable::sync_parent(&path)?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn save_book_import_image_bytes(
        &self,
        import_id: &str,
        img_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        let import_id = crate::paths::sanitize_id(import_id)?;
        let img_name = crate::paths::sanitize_id(img_name)?;
        let inner = self.inner.lock().unwrap();
        let import_root = inner.dir.join("ocr-import-staging").join(import_id);
        let marker = import_root.join(media_assets::IMPORT_PENDING_MARKER);
        if !marker.exists() {
            durable::write_file_atomic(&marker, b"pending", false)?;
        }
        let path = import_root.join("images").join(img_name);
        durable::write_file_atomic(&path, data, false)
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn ensure_new_book_import_id(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.ensure_new_book_import_id_unlocked(id)
    }

    fn ensure_new_book_import_id_unlocked(&self, id: &str) -> Result<(), String> {
        let safe_id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let has_record =
            record_files::load_records(&inner.dir)?.contains_key(&format!("text:{id}"));
        if has_record || inner.books_dir.join(safe_id).exists() {
            return Err("PDF import target already exists; choose a new import id".to_string());
        }
        Ok(())
    }

    #[cfg(target_os = "android")]
    pub(crate) fn begin_book_import_assets(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        self.ensure_new_book_import_id_unlocked(id)?;
        let id = crate::paths::sanitize_id(id)?;
        let inner = self.inner.lock().unwrap();
        let marker = inner
            .books_dir
            .join(id)
            .join(media_assets::IMPORT_PENDING_MARKER);
        durable::write_file_atomic(&marker, b"pending", false)
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn finalize_book_import_assets(
        &self,
        temporary_id: &str,
        final_id: &str,
    ) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        self.ensure_new_book_import_id_unlocked(final_id)?;
        let temporary_id = crate::paths::sanitize_id(temporary_id)?;
        let final_id = crate::paths::sanitize_id(final_id)?;
        let inner = self.inner.lock().unwrap();
        let source = inner.dir.join("ocr-import-staging").join(&temporary_id);
        if !source.is_dir() {
            return Ok(());
        }
        let target = inner.books_dir.join(&final_id);
        std::fs::rename(&source, &target).map_err(|e| {
            format!(
                "could not finalize PDF import {} as {}: {e}",
                source.display(),
                target.display()
            )
        })?;
        if let Err(error) = durable::sync_parent(&source)
            .and_then(|_| durable::sync_parent(&target))
            .and_then(|_| media_assets::validate_imported_book_assets(&inner.dir, &final_id))
        {
            let rollback = std::fs::rename(&target, &source);
            if rollback.is_ok() {
                let _ = durable::sync_parent(&target);
                let _ = durable::sync_parent(&source);
            }
            let manifest_cleanup =
                media_assets::discard_imported_book_assets(&inner.dir, &final_id, self.device_id());
            if rollback.is_err() {
                let _ = std::fs::remove_dir_all(&target);
                let _ = durable::sync_parent(&target);
            }
            return match (rollback, manifest_cleanup) {
                (Ok(()), Ok(())) => Err(error),
                (rollback, cleanup) => Err(format!(
                    "{error}; PDF import rollback failed: {rollback:?}; manifest cleanup: {cleanup:?}"
                )),
            };
        }
        Ok(())
    }

    fn complete_pending_book_import(
        &self,
        dir: &std::path::Path,
        book_id: &str,
    ) -> Result<(), String> {
        let marker = dir
            .join("books")
            .join(book_id)
            .join(media_assets::IMPORT_PENDING_MARKER);
        if !marker.is_file() {
            return Ok(());
        }
        media_assets::finalize_imported_book_assets(dir, book_id, self.device_id())?;
        durable::remove_file_if_exists(&marker)
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
        self.recover_pending_save()?;
        if payload
            .get("pending_import")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let safe_book = crate::paths::sanitize_id(book_id)?;
            let inner = self.inner.lock().unwrap();
            let marker = inner
                .books_dir
                .join(safe_book)
                .join(media_assets::IMPORT_PENDING_MARKER);
            if !marker.is_file() {
                return Err("PDF import is no longer active".to_string());
            }
        }
        self.save_book_image_bytes_unlocked(book_id, img_name, &data)
    }

    #[cfg(test)]
    pub(crate) fn save_book_image_bytes(
        &self,
        book_id: &str,
        img_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
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
        let relative = format!("books/{safe_book}/images/{safe_img}");
        let image_path = media_assets::safe_join(&inner.dir, &relative)?;
        let img_dir = image_path
            .parent()
            .ok_or_else(|| "book image path has no parent".to_string())?;
        std::fs::create_dir_all(img_dir).map_err(|e| e.to_string())?;
        durable::write_file_atomic(&image_path, data, false)?;
        if inner
            .books_dir
            .join(&safe_book)
            .join(media_assets::IMPORT_PENDING_MARKER)
            .is_file()
        {
            return Ok(());
        }
        media_assets::record_saved_book_asset(
            &inner.dir,
            &safe_book,
            &safe_img,
            data,
            self.device_id(),
        )
    }

    pub fn book_image_path(&self, book: &str, img: &str) -> Result<std::path::PathBuf, String> {
        let safe_book = crate::paths::sanitize_id(book)?;
        let safe_img = crate::paths::sanitize_id(img)?;
        let inner = self.inner.lock().unwrap();
        media_assets::safe_join(&inner.dir, &format!("books/{safe_book}/images/{safe_img}"))
    }
}

fn existing_text_data(dir: &std::path::Path, id: &str) -> Result<Value, String> {
    let records = record_files::load_records(dir)?;
    match records
        .get(&format!("text:{id}"))
        .filter(|record| record.deleted_at.is_none())
    {
        Some(record) if record.data.is_object() => Ok(record.data.clone()),
        Some(_) => Err("stored text record is not an object".to_string()),
        None => Ok(Value::Object(Map::new())),
    }
}

fn validate_pdf_page_assets(
    dir: &std::path::Path,
    id: &str,
    metadata: &Value,
) -> Result<(), String> {
    let Some(pages) = metadata.get("pdfOcrPages").and_then(Value::as_array) else {
        return Ok(());
    };
    for page in pages {
        let Some(image_name) = page.get("imageName").and_then(Value::as_str) else {
            continue;
        };
        let image_name = crate::paths::sanitize_id(image_name)?;
        let image = dir.join("books").join(id).join("images").join(image_name);
        if !image.is_file() {
            return Err(format!(
                "PDF page image is missing for book {id}: {}",
                image.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use serde_json::json;

    use crate::store::{Store, StoreInner, media_assets, record_files};

    #[test]
    fn book_record_keeps_text_and_metadata_together() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
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
        let records = record_files::load_records(dir.path()).unwrap();
        assert_eq!(records["text:book"].data["title"], "Renamed");
        assert_eq!(records["text:book"].data["text"], "content");
        assert!(!books_dir.join("book").exists());
    }

    #[test]
    fn language_prefixed_book_ids_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir: books_dir.clone(),
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
    fn text_read_does_not_scan_unrelated_record_directories() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };
        store
            .upsert_text(&json!({ "id": "direct-read", "text": "authoritative text" }))
            .unwrap();
        std::fs::write(
            record_files::records_root(dir.path()).join("vocab"),
            b"not a directory",
        )
        .unwrap();

        assert_eq!(
            store.get_text_content("direct-read").unwrap(),
            "authoritative text"
        );
    }

    #[test]
    fn failed_import_assets_can_be_discarded_without_creating_a_text_record() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir: books_dir.clone(),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };
        store
            .save_book_import_image_bytes("de-pdf-ocr-failed", "page.png", b"partial")
            .unwrap();

        store
            .discard_book_import_assets("de-pdf-ocr-failed")
            .unwrap();

        assert!(
            !dir.path()
                .join("ocr-import-staging/de-pdf-ocr-failed")
                .exists()
        );
        assert!(
            !record_files::load_records(dir.path())
                .unwrap()
                .contains_key("text:de-pdf-ocr-failed")
        );
        assert!(
            !dir.path()
                .join("records/v1/assets/media-manifest.json")
                .exists()
        );
    }

    #[test]
    fn abandoned_import_staging_is_removed_during_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(dir.path().join("ocr-import-staging/abandoned/images")).unwrap();
        std::fs::create_dir_all(books_dir.join("pending/images")).unwrap();
        std::fs::write(
            books_dir
                .join("pending")
                .join(media_assets::IMPORT_PENDING_MARKER),
            b"pending",
        )
        .unwrap();
        std::fs::write(
            dir.path()
                .join("ocr-import-staging/abandoned/images/page.png"),
            b"partial",
        )
        .unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir: books_dir.clone(),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };

        store.discard_abandoned_book_imports().unwrap();

        assert!(!dir.path().join("ocr-import-staging").exists());
        assert!(!books_dir.join("pending").exists());
    }

    #[test]
    fn recovery_without_pending_import_does_not_scan_records() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        std::fs::create_dir_all(record_files::records_root(dir.path())).unwrap();
        std::fs::write(
            record_files::records_root(dir.path()).join("vocab"),
            b"not a directory",
        )
        .unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };

        store.discard_abandoned_book_imports().unwrap();
    }

    #[test]
    fn pdf_import_rejects_an_existing_text_or_asset_id() {
        let dir = tempfile::tempdir().unwrap();
        let books_dir = dir.path().join("books");
        std::fs::create_dir_all(&books_dir).unwrap();
        let store = Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir,
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "test-device".to_string(),
        };
        store
            .upsert_text(&json!({ "id": "de-existing", "text": "keep" }))
            .unwrap();

        assert!(store.ensure_new_book_import_id("de-existing").is_err());
        assert!(store.ensure_new_book_import_id("de-new").is_ok());
        store
            .save_book_import_image_bytes("ocr-temp", "page.png", b"page")
            .unwrap();
        assert!(
            store
                .finalize_book_import_assets("ocr-temp", "de-existing")
                .is_err()
        );
        assert!(dir.path().join("ocr-import-staging/ocr-temp").is_dir());
        assert_eq!(store.get_text_content("de-existing").unwrap(), "keep");
        store
            .finalize_book_import_assets("ocr-temp", "de-new")
            .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("books/de-new/images/page.png")).unwrap(),
            b"page"
        );
        assert!(
            dir.path()
                .join("books/de-new")
                .join(media_assets::IMPORT_PENDING_MARKER)
                .is_file()
        );
        assert!(
            !dir.path()
                .join("records/v1/assets/media-manifest.json")
                .exists()
        );
        store
            .upsert_text(&json!({
                "id": "de-new",
                "text": "page",
                "pdfOcrPages": [{ "imageName": "page.png", "text": "page" }]
            }))
            .unwrap();
        let manifest =
            std::fs::read_to_string(dir.path().join("records/v1/assets/media-manifest.json"))
                .unwrap();
        assert!(manifest.contains("books/de-new/images/page.png"));
        assert!(!manifest.contains("ocr-temp"));
        assert!(
            !dir.path()
                .join("books/de-new")
                .join(media_assets::IMPORT_PENDING_MARKER)
                .exists()
        );
    }
}
