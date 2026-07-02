use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::Store;
use super::record_files;

const SNAPSHOT_SCHEMA_VERSION: u64 = 2;
const MIGRATION_STATUS_SCHEMA_VERSION: u64 = 1;
const MIGRATION_STATUS_FILE: &str = "migration-status.json";
const MIGRATION_BACKUP_DIR: &str = "migration-backups";
const LEGACY_TO_RECORDS_MIGRATION: &str = "legacy-to-records-v1";

impl Store {
    fn save_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("save-journal.json")
    }

    fn wipe_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("wipe-journal.json")
    }

    fn migration_status_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join(MIGRATION_STATUS_FILE)
    }

    pub(crate) fn recover_pending_save(&self) -> Result<(), String> {
        if self.recover_pending_wipe()? {
            return Ok(());
        }
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

    fn recover_pending_wipe(&self) -> Result<bool, String> {
        let journal = self.wipe_journal_path();
        if !journal.exists() {
            return Ok(false);
        }
        eprintln!("[store] completing interrupted wipe");
        self.write_wipe_tombstones()?;
        self.remove_legacy_state_after_wipe()?;
        remove_if_exists(self.save_journal_path())?;
        remove_if_exists(self.save_journal_path().with_extension("tmp"))?;
        std::fs::remove_file(journal).map_err(|e| e.to_string())?;
        Ok(true)
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn recover_pending_save_guarded(&self) -> Result<(), String> {
        let _guard = self.lock_writes()?;
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
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "dataDir": self.dir(),
            "texts": texts,
            "prefs": prefs,
            "hiddenBooks": hidden_books,
            "vocab": vocab,
            "errors": errors,
        })
    }

    pub fn snapshot(&self) -> Value {
        let _guard = match self.lock_writes() {
            Ok(guard) => guard,
            Err(error) => return add_snapshot_error(self.legacy_snapshot(), error),
        };
        self.snapshot_unlocked()
    }

    pub(crate) fn snapshot_unlocked(&self) -> Value {
        let legacy = self.legacy_snapshot();
        let mut snapshot = match self.records_snapshot(&legacy) {
            Ok(snapshot) => snapshot,
            Err(error) => add_snapshot_error(legacy, format!("records: {error}")),
        };
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &self.dir());
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        add_migration_status_to_snapshot(&mut snapshot, self.migration_status());
        snapshot
    }

    pub fn bulk_save(&self, payload: Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
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
        record_files::prepare_local_records(&mut incoming, &base, self.device_id(), now);
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
        let _guard = self.lock_writes()?;
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
        add_sync_status_to_snapshot(&mut snapshot, &local_dir);
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        add_migration_status_to_snapshot(&mut snapshot, self.migration_status());
        Ok(snapshot)
    }

    pub fn sync_status(&self) -> Value {
        record_files::sync_status(&self.dir())
    }

    pub fn recovery_status(&self) -> Value {
        let dir = self.dir();
        let mut status = record_files::recovery_status(&dir);
        status["pendingSaveJournal"] = Value::Bool(self.save_journal_path().exists());
        status["pendingSaveJournalTemp"] =
            Value::Bool(self.save_journal_path().with_extension("tmp").exists());
        status["pendingWipeJournal"] = Value::Bool(self.wipe_journal_path().exists());
        status["quarantinedSaveJournal"] = Value::Bool(dir.join("save-journal.bad").exists());
        status
    }

    pub fn resolve_sync_conflict(&self, id: &str, resolution: &str) -> Result<Value, String> {
        let _guard = self.lock_writes()?;
        let use_conflict = match resolution {
            "keep-current" => false,
            "use-conflict" => true,
            _ => return Err("unsupported conflict resolution".to_string()),
        };
        let dir = self.dir();
        record_files::resolve_conflict(&dir, id, use_conflict)?;
        let records = record_files::load_records(&dir)?;
        if use_conflict {
            let payload = record_files::records_to_payload(&dir, &records);
            self.apply_bulk_save(&payload)?;
        }
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        let mut snapshot = snapshot_payload(&dir, &records);
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &dir);
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        add_migration_status_to_snapshot(&mut snapshot, self.migration_status());
        Ok(snapshot)
    }

    fn migration_status(&self) -> Value {
        let path = self.migration_status_path();
        if let Ok(raw) = std::fs::read(&path) {
            if let Ok(status) = serde_json::from_slice::<Value>(&raw) {
                return status;
            }
        }
        let records_active = record_files::has_records(&self.dir());
        json!({
            "schemaVersion": MIGRATION_STATUS_SCHEMA_VERSION,
            "migration": LEGACY_TO_RECORDS_MIGRATION,
            "status": if records_active { "records-active" } else { "not-needed" },
            "recordsActive": records_active,
            "legacySourcesPreservedInPlace": false,
            "legacyBackup": Value::Null,
        })
    }

    fn records_snapshot(&self, legacy: &Value) -> Result<Value, String> {
        let dir = self.dir();
        let mut records = record_files::load_records(&dir)?;
        let mut changed = record_files::revive_same_device_tombstone_backups(
            &dir,
            &mut records,
            self.device_id(),
        )?;
        // Legacy JSON has no per-record clock, so seed it older than synced records.
        let mut legacy_records = record_files::payload_to_records(legacy, self.device_id(), 1);
        self.hydrate_text_records(&mut legacy_records)?;
        let legacy_record_count = legacy_records.len();
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
        if legacy_record_count > 0 && !records.is_empty() {
            self.ensure_legacy_migration_status(legacy_record_count);
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

    fn ensure_legacy_migration_status(&self, legacy_record_count: usize) {
        let status_path = self.migration_status_path();
        let previous_status = read_json_file(&status_path);
        if let Some(status) = previous_status.as_ref() {
            if migration_backup_complete(status) {
                return;
            }
        }
        let now = record_files::now_millis().to_string();
        let created_at = previous_status
            .as_ref()
            .and_then(|status| status.get("createdAt"))
            .and_then(Value::as_str)
            .unwrap_or(&now);
        let legacy_backup = self.backup_legacy_sources();
        let status = json!({
            "schemaVersion": MIGRATION_STATUS_SCHEMA_VERSION,
            "migration": LEGACY_TO_RECORDS_MIGRATION,
            "status": "complete",
            "recordsActive": true,
            "legacySourcesPreservedInPlace": true,
            "createdAt": created_at,
            "updatedAt": now,
            "legacyRecordCount": legacy_record_count,
            "legacyBackup": legacy_backup,
        });
        if let Err(error) = write_json_atomically(&status_path, &status) {
            eprintln!("[migration] failed to write migration status: {error}");
        }
    }

    fn backup_legacy_sources(&self) -> Value {
        let dir = self.dir();
        let backup_dir = dir
            .join(MIGRATION_BACKUP_DIR)
            .join(LEGACY_TO_RECORDS_MIGRATION);
        let mut copied = Vec::new();
        let mut errors = Vec::new();
        if let Err(error) = std::fs::create_dir_all(&backup_dir) {
            errors.push(format!("create backup dir: {error}"));
        } else {
            for name in [
                "store.sqlite",
                "store.sqlite-wal",
                "store.sqlite-shm",
                "vocab.json",
                "vocab.bak",
            ] {
                let source = dir.join(name);
                if !source.is_file() {
                    continue;
                }
                match std::fs::copy(&source, backup_dir.join(name)) {
                    Ok(_) => copied.push(Value::String(name.to_string())),
                    Err(error) => errors.push(format!("{name}: {error}")),
                }
            }
        }
        let ok = errors.is_empty();
        json!({
            "ok": ok,
            "path": backup_dir.to_string_lossy(),
            "copiedFiles": copied,
            "errors": errors,
            "legacySourcesPreservedInPlace": true,
            "booksDirectoryPreservedInPlace": dir.join("books").is_dir(),
        })
    }

    pub fn wipe(&self) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.write_wipe_journal()?;
        self.write_wipe_tombstones()?;
        self.remove_legacy_state_after_wipe()?;
        std::fs::remove_file(self.wipe_journal_path()).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn write_wipe_journal(&self) -> Result<(), String> {
        let journal = self.wipe_journal_path();
        let temp = journal.with_extension("tmp");
        let bytes = serde_json::to_vec(&json!({
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "op": "wipe",
            "deviceId": self.device_id(),
            "createdAt": record_files::now_millis().to_string(),
        }))
        .map_err(|e| e.to_string())?;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &journal).map_err(|e| e.to_string())
    }

    fn write_wipe_tombstones(&self) -> Result<(), String> {
        let legacy = self.legacy_snapshot();
        self.records_snapshot(&legacy)?;
        let records = record_files::tombstone_all(&self.dir(), self.device_id())?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        Ok(())
    }

    fn remove_legacy_state_after_wipe(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        record_files::remove_record_backups(&inner.dir)?;
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
        let migration_status = inner.dir.join(MIGRATION_STATUS_FILE);
        remove_if_exists(&migration_status)?;
        remove_if_exists(migration_status.with_extension("tmp"))?;
        let migration_backups = inner.dir.join(MIGRATION_BACKUP_DIR);
        if migration_backups.exists() {
            std::fs::remove_dir_all(migration_backups).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn quarantine_journal(path: &Path) -> Result<(), String> {
    let bad = path.with_extension("bad");
    let _ = std::fs::remove_file(&bad);
    std::fs::rename(path, &bad).map_err(|e| e.to_string())
}

fn remove_if_exists(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn read_json_file(path: &Path) -> Option<Value> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice::<Value>(&raw).ok()
}

fn migration_backup_complete(status: &Value) -> bool {
    status.get("migration").and_then(Value::as_str) == Some(LEGACY_TO_RECORDS_MIGRATION)
        && status.get("status").and_then(Value::as_str) == Some("complete")
        && status
            .get("legacyBackup")
            .and_then(|backup| backup.get("ok"))
            .and_then(Value::as_bool)
            == Some(true)
}

fn add_sync_dir_to_snapshot(snapshot: &mut Value) {
    if let Ok(Some(sync_dir)) = crate::paths::sync_dir(crate::APP_NAME) {
        snapshot["syncDir"] = Value::String(sync_dir.to_string_lossy().into_owned());
    }
}

fn add_sync_status_to_snapshot(snapshot: &mut Value, dir: &Path) {
    let status = record_files::sync_status(dir);
    snapshot["syncConflictCount"] = status
        .get("conflictCount")
        .cloned()
        .unwrap_or_else(|| Value::from(0));
    snapshot["syncConflicts"] = status
        .get("conflicts")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
}

fn add_recovery_status_to_snapshot(snapshot: &mut Value, status: Value) {
    snapshot["recoveryStatus"] = status;
}

fn add_migration_status_to_snapshot(snapshot: &mut Value, status: Value) {
    snapshot["migrationStatus"] = status;
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
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use serde_json::{Map, Value, json};

    use crate::store::{Store, StoreInner, record_files};

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

    fn causal(entries: &[(&str, u64)]) -> BTreeMap<String, u64> {
        entries
            .iter()
            .map(|(device, counter)| ((*device).to_string(), *counter))
            .collect()
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
    fn snapshot_migrates_historical_legacy_fixture_copy_forward() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            dir.path().join("vocab.json"),
            include_str!("fixtures/legacy-0.3.5-vocab.json"),
        )
        .unwrap();
        let book_dir = dir.path().join("books/fr-custom-maison");
        std::fs::create_dir_all(&book_dir).unwrap();
        std::fs::write(
            book_dir.join("metadata.json"),
            include_str!("fixtures/legacy-0.3.5-book-metadata.json"),
        )
        .unwrap();
        std::fs::write(
            book_dir.join("text.txt"),
            include_str!("fixtures/legacy-0.3.5-book-text.txt"),
        )
        .unwrap();

        let snapshot = store.snapshot();
        let records = record_files::load_records(dir.path()).unwrap();

        assert_eq!(snapshot["migrationStatus"]["status"], "complete");
        assert_eq!(
            snapshot["vocab"]["fr"]["vocab"]["maison"]["status"],
            "known"
        );
        assert_eq!(snapshot["texts"][0]["id"], "fr-custom-maison");
        assert_eq!(
            store.get_text_content("fr-custom-maison").unwrap(),
            include_str!("fixtures/legacy-0.3.5-book-text.txt")
        );
        assert!(records.contains_key("profile:fr"));
        assert!(records.contains_key("vocab:fr:maison"));
        assert!(records.contains_key("text:fr-custom-maison"));
        assert!(records.contains_key("book:fr:fr-user-1"));
        assert!(dir.path().join("vocab.json").is_file());
        assert!(book_dir.join("metadata.json").is_file());
        assert!(book_dir.join("text.txt").is_file());
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
                causal: causal(&[("test-device", 10)]),
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
                causal: causal(&[("test-device", 10)]),
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
        assert_eq!(
            store.sync_status()["conflictCount"].as_u64(),
            Some(conflict_count as u64)
        );
        let status = store.sync_status();
        let conflicts = status["conflicts"].as_array().unwrap();
        assert_eq!(conflicts.len(), conflict_count);
        assert_eq!(conflicts[0]["key"], "vocab:de:wort");
        assert_eq!(conflicts[0]["reason"], "concurrent-record-changes");
        assert_eq!(conflicts[0]["kept"]["kind"], "vocab");
        assert_eq!(conflicts[0]["conflict"]["kind"], "vocab");
        assert_eq!(
            store.snapshot()["syncConflictCount"].as_u64(),
            Some(conflict_count as u64)
        );
        assert_eq!(store.snapshot()["syncConflicts"][0]["key"], "vocab:de:wort");
    }

    #[test]
    fn resolving_conflict_keep_current_removes_conflict_file() {
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
        let id = store.sync_status()["conflicts"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let snapshot = store.resolve_sync_conflict(&id, "keep-current").unwrap();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["wort"]["translation"],
            "local"
        );
        assert_eq!(store.sync_status()["conflictCount"].as_u64(), Some(0));
        assert!(
            store.sync_status()["conflicts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn resolving_conflict_use_conflict_applies_preserved_record() {
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
        let id = store.sync_status()["conflicts"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let snapshot = store.resolve_sync_conflict(&id, "use-conflict").unwrap();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["wort"]["translation"],
            "cloud"
        );
        assert_eq!(store.sync_status()["conflictCount"].as_u64(), Some(0));
    }

    #[test]
    fn store_mutations_wait_for_global_write_lock() {
        let dir = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = Arc::new(store_at(&dir));
        let guard = store.lock_writes().unwrap();
        let (tx, rx) = mpsc::channel();

        for (name, task) in [
            (
                "bulk_save",
                Box::new({
                    let store = Arc::clone(&store);
                    move || store.bulk_save(profile_payload("lock", "save"))
                }) as Box<dyn FnOnce() -> Result<(), String> + Send>,
            ),
            (
                "upsert_text",
                Box::new({
                    let store = Arc::clone(&store);
                    move || {
                        store.upsert_text(&json!({
                            "id": "de-custom-lock",
                            "title": "Lock",
                            "text": "locked text"
                        }))
                    }
                }),
            ),
            (
                "delete_text",
                Box::new({
                    let store = Arc::clone(&store);
                    move || store.delete_text("de-custom-delete")
                }),
            ),
            (
                "save_book_image",
                Box::new({
                    let store = Arc::clone(&store);
                    move || store.save_book_image_bytes("de-custom-lock", "cover.jpg", b"cover")
                }),
            ),
            (
                "snapshot",
                Box::new({
                    let store = Arc::clone(&store);
                    move || {
                        let _ = store.snapshot();
                        Ok(())
                    }
                }),
            ),
        ] {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let result = task();
                tx.send((name, result)).unwrap();
            });
        }

        {
            let store = Arc::clone(&store);
            let remote = remote.path().to_path_buf();
            let tx = tx.clone();
            std::thread::spawn(move || {
                let result = store.sync_with_directory(remote).map(|_| ());
                tx.send(("sync_with_directory", result)).unwrap();
            });
        }

        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        drop(guard);

        let mut completed = Vec::new();
        for _ in 0..6 {
            let (name, result) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            result.unwrap();
            completed.push(name);
        }
        completed.sort();
        assert_eq!(
            completed,
            [
                "bulk_save",
                "delete_text",
                "save_book_image",
                "snapshot",
                "sync_with_directory",
                "upsert_text"
            ]
        );
        assert!(record_files::load_records(&store.dir()).is_ok());
        assert!(
            store
                .book_image_path("de-custom-lock", "cover.jpg")
                .unwrap()
                .is_file()
        );
    }

    #[test]
    fn first_snapshot_migrates_legacy_state_copy_forward_with_backup_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        let mut prefs = Map::new();
        prefs.insert("learningLanguage".to_string(), json!("de"));
        prefs.insert("theme".to_string(), json!("dark"));
        store.set_prefs(&prefs).unwrap();
        store
            .save_vocab(&json!({
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {
                        "haus": {
                            "word": "haus",
                            "translation": "house",
                            "status": "known"
                        }
                    }
                }
            }))
            .unwrap();

        let snapshot = store.snapshot();
        let status_path = store.migration_status_path();
        let status: Value = serde_json::from_slice(&std::fs::read(&status_path).unwrap()).unwrap();
        let backup_path = PathBuf::from(
            status["legacyBackup"]["path"]
                .as_str()
                .expect("backup path"),
        );
        let records = record_files::load_records(dir.path()).unwrap();

        assert_eq!(snapshot["migrationStatus"]["status"], "complete");
        assert_eq!(status["status"], "complete");
        assert_eq!(status["migration"], super::LEGACY_TO_RECORDS_MIGRATION);
        assert_eq!(status["recordsActive"], true);
        assert_eq!(status["legacySourcesPreservedInPlace"], true);
        assert!(records.contains_key("profile:de"));
        assert!(records.contains_key("vocab:de:haus"));
        assert!(records.contains_key("pref:theme"));
        assert!(dir.path().join("vocab.json").is_file());
        assert!(dir.path().join("store.sqlite").is_file());
        assert!(backup_path.join("vocab.json").is_file());
        assert!(backup_path.join("store.sqlite").is_file());
        assert_eq!(status["legacyBackup"]["ok"], true);
        assert_eq!(
            status["legacyBackup"]["legacySourcesPreservedInPlace"],
            true
        );
        assert_eq!(
            status["legacyBackup"]["booksDirectoryPreservedInPlace"],
            true
        );

        let mut retry_status = status.clone();
        retry_status["legacyBackup"]["ok"] = Value::Bool(false);
        retry_status["legacyBackup"]["path"] = Value::String("stale-backup-path".to_string());
        std::fs::write(&status_path, serde_json::to_vec(&retry_status).unwrap()).unwrap();
        let retried_snapshot = store.snapshot();
        let retried_status: Value =
            serde_json::from_slice(&std::fs::read(&status_path).unwrap()).unwrap();
        assert_eq!(retried_snapshot["migrationStatus"]["status"], "complete");
        assert_eq!(retried_status["legacyBackup"]["ok"], true);
        assert_eq!(
            retried_status["legacyBackup"]["path"],
            status["legacyBackup"]["path"]
        );

        let second_snapshot = store.snapshot();
        let second_status: Value =
            serde_json::from_slice(&std::fs::read(&status_path).unwrap()).unwrap();
        assert_eq!(second_snapshot["migrationStatus"]["status"], "complete");
        assert_eq!(
            second_status["legacyBackup"]["path"],
            status["legacyBackup"]["path"]
        );

        store.wipe().unwrap();
        assert!(!status_path.exists());
        assert!(!backup_path.exists());
        assert!(!dir.path().join(super::MIGRATION_BACKUP_DIR).exists());
        let after_wipe_snapshot = store.snapshot();
        let after_wipe_records = record_files::load_records(dir.path()).unwrap();
        assert!(
            after_wipe_snapshot["vocab"]["de"]["vocab"]
                .as_object()
                .map(|vocab| !vocab.contains_key("haus"))
                .unwrap_or(true)
        );
        assert!(after_wipe_records["vocab:de:haus"].deleted_at.is_some());
    }

    #[test]
    fn recover_pending_wipe_completes_tombstones_before_legacy_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("alt", "old")).unwrap();
        store.write_wipe_journal().unwrap();
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&profile_payload("revived", "bad")).unwrap(),
        )
        .unwrap();

        store.recover_pending_save().unwrap();

        let records = record_files::load_records(dir.path()).unwrap();
        assert!(records["profile:de"].deleted_at.is_some());
        assert!(records["vocab:de:alt"].deleted_at.is_some());
        assert!(!records.contains_key("vocab:de:revived"));
        assert!(!store.wipe_journal_path().exists());
        assert!(!store.save_journal_path().exists());
    }

    #[test]
    fn wipe_tombstones_legacy_only_state_before_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store
            .save_vocab(&json!({
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {
                        "legacy": {
                            "word": "legacy",
                            "translation": "old",
                            "status": "known"
                        }
                    }
                }
            }))
            .unwrap();

        store.wipe().unwrap();

        let records = record_files::load_records(dir.path()).unwrap();
        assert!(records["profile:de"].deleted_at.is_some());
        assert!(records["vocab:de:legacy"].deleted_at.is_some());
        assert!(!dir.path().join("vocab.json").exists());
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
        assert_eq!(snapshot["recoveryStatus"]["quarantinedSaveJournal"], true);
    }

    #[test]
    fn snapshot_reports_pending_recovery_journals() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(store.save_journal_path(), "{}").unwrap();
        std::fs::write(store.save_journal_path().with_extension("tmp"), "{}").unwrap();
        std::fs::write(store.wipe_journal_path(), "{}").unwrap();
        std::fs::write(dir.path().join("save-journal.bad"), "{").unwrap();

        let snapshot = store.snapshot();

        assert_eq!(snapshot["recoveryStatus"]["pendingSaveJournal"], true);
        assert_eq!(snapshot["recoveryStatus"]["pendingSaveJournalTemp"], true);
        assert_eq!(snapshot["recoveryStatus"]["pendingWipeJournal"], true);
        assert_eq!(snapshot["recoveryStatus"]["quarantinedSaveJournal"], true);
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
            .bulk_save(profile_payload_words(&[
                ("haus", "house"),
                ("boot", "boat"),
            ]))
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
                causal: causal(&[("remote-device", 2)]),
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
