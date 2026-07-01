use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::record_files;
use super::Store;

impl Store {
    fn save_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("save-journal.json")
    }

    pub(crate) fn recover_pending_save(&self) -> Result<(), String> {
        let journal = self.save_journal_path();
        let temp = journal.with_extension("tmp");
        let path = if journal.exists() {
            journal
        } else if temp.exists() {
            temp
        } else {
            return Ok(());
        };
        let payload = std::fs::read(&path)
            .map_err(|e| format!("could not read interrupted save journal: {e}"))?;
        let payload = match serde_json::from_slice(&payload) {
            Ok(value) => value,
            Err(error) => {
                quarantine_journal(&path)?;
                eprintln!("interrupted save journal is corrupt: {error}");
                return Ok(());
            }
        };
        self.commit_bulk_save(&payload)?;
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn recover_pending_save_guarded(&self) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())?;
        self.recover_pending_save()
    }

    fn apply_bulk_save(&self, payload: &Value) -> Result<(), String> {
        if let Some(vocab) = payload.get("vocab") {
            self.save_vocab(vocab)?;
        }
        if let Some(texts) = payload.get("texts").and_then(Value::as_array) {
            self.sync_texts(texts)?;
        }
        if let Some(prefs) = payload.get("prefs").and_then(Value::as_object) {
            self.set_prefs(prefs)?;
        }
        if let Some(hidden) = payload.get("hiddenBooks").and_then(Value::as_array) {
            self.set_hidden_books(hidden)?;
        }
        Ok(())
    }

    fn legacy_snapshot(&self) -> Value {
        // Collect data, but also gather any component errors so the frontend can warn
        // the user instead of silently presenting an empty state (which masks data loss).
        let mut errors: Vec<String> = Vec::new();

        let texts = match self.all_texts() {
            Ok(v) => Value::Array(v),
            Err(e) => {
                errors.push(format!("texts: {e}"));
                Value::Array(Vec::new())
            }
        };
        let prefs = match self.all_prefs() {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("prefs: {e}"));
                json!({})
            }
        };
        let hidden_books = match self.hidden_books() {
            Ok(v) => Value::Array(v.into_iter().map(Value::from).collect()),
            Err(e) => {
                errors.push(format!("hiddenBooks: {e}"));
                Value::Array(Vec::new())
            }
        };
        let vocab = match self.load_vocab() {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("vocab: {e}"));
                json!({})
            }
        };

        // Surface component failures via stderr so they aren't silently swallowed.
        for err in &errors {
            eprintln!("[snapshot] failed to load {err}");
        }

        json!({
            "dataDir": self.dir(),
            "texts": texts,
            "prefs": prefs,
            "hiddenBooks": hidden_books,
            "vocab": vocab,
            "errors": errors,
        })
    }

    pub fn snapshot(&self) -> Value {
        let legacy = self.legacy_snapshot();
        let mut snapshot = match self.records_snapshot(&legacy) {
            Ok(snapshot) => snapshot,
            Err(error) => add_snapshot_error(legacy, format!("records: {error}")),
        };
        add_sync_dir_to_snapshot(&mut snapshot);
        snapshot
    }

    pub fn bulk_save(&self, payload: Value) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())?;
        let journal = self.save_journal_path();
        if journal.exists() {
            quarantine_journal(&journal)?;
        }
        let temp = journal.with_extension("tmp");
        let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &journal).map_err(|e| e.to_string())?;

        self.commit_bulk_save(&payload)?;
        std::fs::remove_file(journal).map_err(|e| e.to_string())
    }

    pub(crate) fn commit_bulk_save(&self, payload: &Value) -> Result<(), String> {
        let now = record_files::now_millis();
        let mut incoming = record_files::payload_to_records(payload, self.device_id(), now);
        self.hydrate_text_records(&mut incoming)?;
        let current = record_files::load_records(&self.dir())?;
        let base = self.base_records.lock().unwrap().clone();
        let merged = record_files::merge_records(&base, incoming, current, self.device_id(), now);
        record_files::write_records(&self.dir(), &merged.records)?;
        record_files::write_conflicts(&self.dir(), &merged.conflicts)?;
        let merged_payload = record_files::records_to_payload(&self.dir(), &merged.records);
        self.apply_bulk_save(&merged_payload)?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&merged.records);
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn seed_or_refresh_records(&self) -> Result<(), String> {
        let legacy = self.legacy_snapshot();
        self.records_snapshot(&legacy).map(|_| ())
    }

    pub fn sync_with_directory(&self, sync_dir: PathBuf) -> Result<Value, String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())?;
        std::fs::create_dir_all(&sync_dir).map_err(|e| e.to_string())?;

        let local_dir = self.dir();
        let legacy = self.legacy_snapshot();
        self.records_snapshot(&legacy)?;
        let now = record_files::now_millis();

        let mut local_records = record_files::load_records(&local_dir)?;
        if record_files::revive_same_device_tombstone_backups(
            &local_dir,
            &mut local_records,
            self.device_id(),
        )? {
            record_files::write_records(&local_dir, &local_records)?;
        }
        let remote_records = record_files::load_records(&sync_dir)?;
        let merged = record_files::merge_records(
            &BTreeMap::new(),
            local_records,
            remote_records,
            self.device_id(),
            now,
        );

        record_files::write_records(&local_dir, &merged.records)?;
        record_files::write_conflicts(&local_dir, &merged.conflicts)?;
        record_files::write_records(&sync_dir, &merged.records)?;
        record_files::write_conflicts(&sync_dir, &merged.conflicts)?;

        copy_media_assets(&sync_dir, &local_dir)?;
        let merged_payload = record_files::records_to_payload(&local_dir, &merged.records);
        self.apply_bulk_save(&merged_payload)?;
        copy_media_assets(&local_dir, &sync_dir)?;

        let applied_records = record_files::load_records(&local_dir)?;
        record_files::write_records(&sync_dir, &applied_records)?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&applied_records);
        let mut snapshot = snapshot_payload(&local_dir, &applied_records);
        add_sync_dir_to_snapshot(&mut snapshot);
        Ok(snapshot)
    }

    fn records_snapshot(&self, legacy: &Value) -> Result<Value, String> {
        let dir = self.dir();
        let mut records = record_files::load_records(&dir)?;
        let mut changed = record_files::revive_same_device_tombstone_backups(
            &dir,
            &mut records,
            self.device_id(),
        )?;
        // ponytail: legacy JSON has no per-record clock; seed it older than synced records.
        let mut legacy_records = record_files::payload_to_records(legacy, self.device_id(), 1);
        self.hydrate_text_records(&mut legacy_records)?;
        for (key, record) in legacy_records {
            let Some(existing) = records.get_mut(&key) else {
                records.insert(key, record);
                changed = true;
                continue;
            };
            if existing.deleted_at.is_some()
                && existing.device_id == self.device_id()
                && record.deleted_at.is_none()
            {
                *existing = record;
                changed = true;
            } else if record_files::merge_missing_text_metadata(existing, &record) {
                changed = true;
            }
        }
        if changed {
            record_files::write_records(&dir, &records)?;
        }
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        if records.is_empty() {
            return Ok(legacy.clone());
        }
        let mut snapshot = snapshot_payload(&dir, &records);
        if let Some(errors) = legacy.get("errors").and_then(Value::as_array) {
            snapshot["errors"] = Value::Array(errors.clone());
        }
        Ok(snapshot)
    }

    pub fn wipe(&self) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "save lock is unavailable".to_string())?;
        {
            let inner = self.inner.lock().unwrap();
            let conn = Self::conn(&inner)?;
            conn.execute("DELETE FROM prefs", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM hidden_books", [])
                .map_err(|e| e.to_string())?;
            if inner.vocab_path.exists() {
                std::fs::remove_file(&inner.vocab_path).map_err(|e| e.to_string())?;
            }
            let bak_path = inner.vocab_path.with_extension("bak");
            if bak_path.exists() {
                std::fs::remove_file(bak_path).map_err(|e| e.to_string())?;
            }
            if inner.books_dir.exists() {
                for entry in std::fs::read_dir(&inner.books_dir).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entry.path().is_dir() {
                        std::fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        let records = record_files::tombstone_all(&self.dir(), self.device_id())?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        Ok(())
    }
}

fn quarantine_journal(path: &Path) -> Result<(), String> {
    let bad = path.with_extension("bad");
    let _ = std::fs::remove_file(&bad);
    std::fs::rename(path, &bad).map_err(|e| e.to_string())
}

fn add_sync_dir_to_snapshot(snapshot: &mut Value) {
    if let Ok(Some(sync_dir)) = crate::paths::sync_dir(crate::APP_NAME) {
        snapshot["syncDir"] = Value::String(sync_dir.to_string_lossy().into_owned());
    }
}

fn copy_media_assets(from_root: &Path, to_root: &Path) -> Result<(), String> {
    copy_tree_filtered(&from_root.join("books"), &to_root.join("books"), true)?;
    copy_tree_filtered(
        &from_root.join("argos-packages"),
        &to_root.join("argos-packages"),
        false,
    )
}

fn copy_tree_filtered(from: &Path, to: &Path, skip_book_records: bool) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if skip_book_records
            && matches!(
                name_text.as_ref(),
                "book.json" | "book.bak" | "metadata.json" | "text.txt"
            )
        {
            continue;
        }
        let target = to.join(&name);
        if source.is_dir() {
            copy_tree_filtered(&source, &target, skip_book_records)?;
        } else if source.is_file() && should_copy_file(&source, &target)? {
            std::fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| "target path has no parent".to_string())?,
            )
            .map_err(|e| e.to_string())?;
            std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn should_copy_file(source: &Path, target: &Path) -> Result<bool, String> {
    if !target.exists() {
        return Ok(true);
    }
    let source_meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
    let target_meta = std::fs::metadata(target).map_err(|e| e.to_string())?;
    if source_meta.len() != target_meta.len() {
        return Ok(true);
    }
    let source_modified = source_meta.modified().ok();
    let target_modified = target_meta.modified().ok();
    Ok(source_modified > target_modified)
}

#[cfg(target_os = "android")]
fn snapshot_payload(
    dir: &std::path::Path,
    records: &BTreeMap<String, record_files::SyncRecord>,
) -> Value {
    record_files::records_to_mobile_snapshot_payload(dir, records)
}

#[cfg(not(target_os = "android"))]
fn snapshot_payload(
    dir: &std::path::Path,
    records: &BTreeMap<String, record_files::SyncRecord>,
) -> Value {
    record_files::records_to_snapshot_payload(dir, records)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use serde_json::{json, Map, Value};

    use crate::store::{record_files, Store, StoreInner};

    fn store_at(dir: &tempfile::TempDir) -> Store {
        store_at_with_device(dir, "test-device")
    }

    fn store_at_with_device(dir: &tempfile::TempDir, device_id: &str) -> Store {
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

    fn profile_payload_words(words: &[(&str, &str)]) -> Value {
        let mut vocab = Map::new();
        for (word, translation) in words {
            vocab.insert(
                (*word).to_string(),
                json!({ "word": word, "translation": translation, "status": "learning" }),
            );
        }
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

    fn user_book_count(payload: &Value) -> usize {
        payload["vocab"]["de"]
            .get("userBooks")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    }

    #[test]
    fn snapshot_seeds_record_files_without_removing_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            dir.path().join("vocab.json"),
            r#"{"de":{"vocab":{"haus":{"word":"haus","translation":"house"}}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("books/de-custom-note")).unwrap();
        std::fs::write(
            dir.path().join("books/de-custom-note/book.json"),
            r#"{"metadata":{"id":"de-custom-note","title":"Note","lang":"de"},"text":"Hallo Welt"}"#,
        )
        .unwrap();

        let snapshot = store.snapshot();

        assert!(dir.path().join("vocab.json").is_file());
        assert!(dir.path().join("records/v1/vocab").is_dir());
        assert!(snapshot["texts"][0].get("text").is_none());
        assert_eq!(
            store.get_text_content("de-custom-note").unwrap(),
            "Hallo Welt"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["haus"]["translation"],
            "house"
        );
    }

    #[test]
    fn snapshot_revives_same_device_tombstones_when_local_legacy_data_exists() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            dir.path().join("vocab.json"),
            r#"{"de":{"vocab":{"haus":{"word":"haus","translation":"house"}}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("books/de-custom-note")).unwrap();
        std::fs::write(
            dir.path().join("books/de-custom-note/book.json"),
            r#"{"metadata":{"id":"de-custom-note","title":"Note","lang":"de"},"text":"Hallo Welt"}"#,
        )
        .unwrap();
        let mut tombstones = BTreeMap::new();
        tombstones.insert(
            "text:de-custom-note".to_string(),
            record_files::SyncRecord {
                key: "text:de-custom-note".to_string(),
                kind: "text".to_string(),
                data: Value::Null,
                updated_at: 10,
                deleted_at: Some(10),
                device_id: "test-device".to_string(),
            },
        );
        tombstones.insert(
            "vocab:de:haus".to_string(),
            record_files::SyncRecord {
                key: "vocab:de:haus".to_string(),
                kind: "vocab".to_string(),
                data: Value::Null,
                updated_at: 10,
                deleted_at: Some(10),
                device_id: "test-device".to_string(),
            },
        );
        record_files::write_records(dir.path(), &tombstones).unwrap();

        let snapshot = store.snapshot();

        assert_eq!(snapshot["texts"][0]["id"], "de-custom-note");
        assert_eq!(
            store.get_text_content("de-custom-note").unwrap(),
            "Hallo Welt"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["haus"]["translation"],
            "house"
        );
    }

    #[test]
    fn snapshot_restores_missing_media_metadata_from_local_book_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::create_dir_all(dir.path().join("books/de-custom-cover")).unwrap();
        std::fs::write(
            dir.path().join("books/de-custom-cover/book.json"),
            r#"{"metadata":{"id":"de-custom-cover","title":"Cover","coverDataUrl":"data:image/jpeg;base64,cover","coverUrl":"https://example.test/cover.jpg","pdfOcrEngine":"paddleocr","pdfOcrPageCount":1,"pdfOcrPages":[{"imageName":"page-1.png","width":100,"height":200,"lines":[]}]},"text":"Hallo Welt"}"#,
        )
        .unwrap();
        let records = record_files::payload_to_records(
            &json!({
                "texts": [{ "id": "de-custom-cover", "title": "Cover", "text": "Hallo Welt" }],
                "prefs": { "learningLanguage": "de" },
                "hiddenBooks": [],
                "vocab": { "de": { "preferences": {}, "vocab": {} } }
            }),
            "remote-device",
            1,
        );
        record_files::write_records(dir.path(), &records).unwrap();

        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["texts"][0]["coverDataUrl"],
            "data:image/jpeg;base64,cover"
        );
        let records = record_files::load_records(dir.path()).unwrap();
        assert_eq!(
            records["text:de-custom-cover"].data["coverDataUrl"],
            "data:image/jpeg;base64,cover"
        );
        assert_eq!(
            records["text:de-custom-cover"].data["coverUrl"],
            "https://example.test/cover.jpg"
        );
        assert_eq!(
            records["text:de-custom-cover"].data["pdfOcrPages"][0]["imageName"],
            "page-1.png"
        );
        assert_eq!(records["text:de-custom-cover"].data["pdfOcrPageCount"], 1);
    }

    #[test]
    fn stale_save_keeps_cloud_record_this_app_did_not_see() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        let original = profile_payload("alt", "old");
        store.bulk_save(original.clone()).unwrap();
        let _ = store.snapshot();

        let cloud_payload = profile_payload("neu", "new");
        let cloud_record = record_files::payload_to_records(&cloud_payload, "cloud-device", 1)
            .remove("vocab:de:neu")
            .unwrap();
        let mut records = record_files::load_records(dir.path()).unwrap();
        records.insert(cloud_record.key.clone(), cloud_record);
        record_files::write_records(dir.path(), &records).unwrap();

        store.bulk_save(original).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["neu"]["translation"],
            "new"
        );
    }

    #[test]
    fn conflicting_record_changes_write_conflict_backup() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("wort", "base")).unwrap();
        let _ = store.snapshot();

        let cloud_payload = profile_payload("wort", "cloud");
        let cloud_record = record_files::payload_to_records(&cloud_payload, "cloud-device", 1)
            .remove("vocab:de:wort")
            .unwrap();
        let mut records = record_files::load_records(dir.path()).unwrap();
        records.insert(cloud_record.key.clone(), cloud_record);
        record_files::write_records(dir.path(), &records).unwrap();

        store.bulk_save(profile_payload("wort", "local")).unwrap();

        let conflict_count = std::fs::read_dir(dir.path().join("records/v1/conflicts"))
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert!(conflict_count > 0);
    }

    #[test]
    fn corrupt_save_journal_is_quarantined_instead_of_blocking_startup() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("alt", "old")).unwrap();
        std::fs::write(store.save_journal_path(), "{").unwrap();

        store.recover_pending_save().unwrap();

        assert!(dir.path().join("save-journal.bad").is_file());
        let snapshot = store.snapshot();
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["alt"]["translation"],
            "old"
        );
    }

    #[test]
    fn bulk_save_quarantines_stale_journal_before_writing_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&profile_payload("stary", "stale")).unwrap(),
        )
        .unwrap();

        store.bulk_save(profile_payload("nowy", "new")).unwrap();
        let snapshot = store.snapshot();

        assert!(dir.path().join("save-journal.bad").is_file());
        assert!(snapshot["vocab"]["de"]["vocab"]["stary"].is_null());
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["nowy"]["translation"],
            "new"
        );
        assert!(!store.save_journal_path().exists());
    }

    #[test]
    fn sync_directory_merges_remote_records_without_relocating_local_data() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store.bulk_save(profile_payload("lokal", "local")).unwrap();

        let remote_payload = profile_payload("fern", "remote");
        let remote_records = record_files::payload_to_records(&remote_payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();

        let snapshot = store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert_eq!(store.dir(), local.path());
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "local"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["fern"]["translation"],
            "remote"
        );
        assert!(remote.path().join("records/v1/vocab").is_dir());
    }

    #[test]
    fn sync_directory_propagates_deleted_vocab_between_devices() {
        let pc = tempfile::tempdir().unwrap();
        let phone = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let pc_store = store_at_with_device(&pc, "pc-device");
        let phone_store = store_at_with_device(&phone, "phone-device");
        pc_store
            .bulk_save(profile_payload_words(&[("haus", "house"), ("boot", "boat")]))
            .unwrap();
        pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        phone_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        phone_store
            .bulk_save(profile_payload_words(&[("haus", "house")]))
            .unwrap();
        phone_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let pc_snapshot = pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let remote_records = record_files::load_records(remote.path()).unwrap();

        assert!(pc_snapshot["vocab"]["de"]["vocab"]["boot"].is_null());
        assert_eq!(
            pc_snapshot["vocab"]["de"]["vocab"]["haus"]["translation"],
            "house"
        );
        assert!(remote_records["vocab:de:boot"].deleted_at.is_some());
    }

    #[test]
    fn sync_directory_keeps_remote_user_book_tombstone_over_legacy_profile_copy() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        std::fs::write(
            local.path().join("vocab.json"),
            serde_json::to_string(&json!({
                "de": {
                    "preferences": {},
                    "userBooks": [{ "id": "user-1", "title": "Old Book" }],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let remote_records = [(
            "book:de:user-1".to_string(),
            record_files::SyncRecord {
                key: "book:de:user-1".to_string(),
                kind: "book".to_string(),
                data: Value::Null,
                updated_at: 2,
                deleted_at: Some(2),
                device_id: "remote-device".to_string(),
            },
        )]
        .into_iter()
        .collect();
        record_files::write_records(remote.path(), &remote_records).unwrap();

        let snapshot = store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let local_records = record_files::load_records(local.path()).unwrap();

        assert_eq!(user_book_count(&snapshot), 0);
        assert_eq!(local_records["book:de:user-1"].deleted_at, Some(2));
    }

    #[test]
    fn sync_directory_copies_remote_book_media_without_copying_book_record() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        let payload = json!({
            "texts": [{
                "id": "de-custom-media",
                "title": "Media",
                "text": "Hallo",
                "coverDataUrl": "/__media?book=de-custom-media&img=cover.jpg"
            }],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": { "de": { "preferences": {}, "vocab": {} } }
        });
        let remote_records = record_files::payload_to_records(&payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();
        let image_dir = remote.path().join("books/de-custom-media/images");
        std::fs::create_dir_all(&image_dir).unwrap();
        std::fs::write(image_dir.join("cover.jpg"), b"cover").unwrap();
        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert_eq!(
            std::fs::read(local.path().join("books/de-custom-media/images/cover.jpg")).unwrap(),
            b"cover"
        );
        let book =
            std::fs::read_to_string(local.path().join("books/de-custom-media/book.json")).unwrap();
        assert!(book.contains("Media"));
    }

    #[test]
    fn recover_pending_save_uses_temp_journal_left_before_rename() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            store.save_journal_path().with_extension("tmp"),
            serde_json::to_vec(&profile_payload("tymczasowy", "temp")).unwrap(),
        )
        .unwrap();

        store.recover_pending_save().unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["tymczasowy"]["translation"],
            "temp"
        );
        assert!(!store.save_journal_path().with_extension("tmp").exists());
    }
}

fn add_snapshot_error(mut snapshot: Value, error: String) -> Value {
    eprintln!("[snapshot] failed to load {error}");
    if let Some(errors) = snapshot.get_mut("errors").and_then(Value::as_array_mut) {
        errors.push(Value::String(error));
    }
    snapshot
}

impl Store {
    fn hydrate_text_records(
        &self,
        records: &mut BTreeMap<String, record_files::SyncRecord>,
    ) -> Result<(), String> {
        for record in records.values_mut().filter(|record| record.kind == "text") {
            let has_text = record.data.get("text").and_then(Value::as_str).is_some();
            if has_text {
                continue;
            }
            let Some(id) = record.key.strip_prefix("text:") else {
                continue;
            };
            let text = self.get_text_content(id)?;
            if text.is_empty() {
                continue;
            }
            if let Some(obj) = record.data.as_object_mut() {
                obj.insert("text".to_string(), Value::String(text));
            }
        }
        Ok(())
    }
}
