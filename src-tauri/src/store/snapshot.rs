use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::Store;
use super::durable;
use super::media_assets;
use super::record_files;

const SNAPSHOT_SCHEMA_VERSION: u64 = 2;
const SAVE_JOURNAL_FORMAT: u64 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingRecovery {
    None,
    Save,
    Wipe,
}

impl Store {
    fn save_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("save-journal.json")
    }

    fn wipe_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("wipe-journal.json")
    }

    fn sync_journal_path(&self) -> std::path::PathBuf {
        self.inner.lock().unwrap().dir.join("sync-journal.json")
    }

    pub(crate) fn recover_pending_save(&self) -> Result<(), String> {
        self.recover_pending_operations().map(|_| ())
    }

    fn recover_pending_operations(&self) -> Result<PendingRecovery, String> {
        if self.recover_pending_wipe()? {
            return Ok(PendingRecovery::Wipe);
        }
        let journal = self.save_journal_path();
        let temp = journal.with_extension("tmp");
        if !journal.exists() && !temp.exists() {
            return Ok(PendingRecovery::None);
        }
        for path in [journal.as_path(), temp.as_path()] {
            if !path.exists() {
                continue;
            }
            let payload = std::fs::read(path)
                .map_err(|e| format!("could not read interrupted save journal: {e}"))?;
            let journal_value: Value = match serde_json::from_slice(&payload) {
                Ok(value) => value,
                Err(error) => {
                    quarantine_journal(path)?;
                    eprintln!("interrupted save journal is corrupt: {error}");
                    continue;
                }
            };
            let current_base = self.base_records.lock().unwrap().clone();
            let (payload, base, saved_at) = match decode_save_journal(&journal_value, current_base)
            {
                Ok(journal) => journal,
                Err(error) => {
                    quarantine_journal(path)?;
                    eprintln!("interrupted save journal is invalid: {error}");
                    continue;
                }
            };
            self.commit_bulk_save_with_context(&payload, &base, saved_at)?;
            remove_if_exists(&journal)?;
            remove_if_exists(&temp)?;
            return Ok(PendingRecovery::Save);
        }
        Ok(PendingRecovery::None)
    }

    fn recover_pending_wipe(&self) -> Result<bool, String> {
        let journal = self.wipe_journal_path();
        let temp = journal.with_extension("tmp");
        if !journal.exists() && !temp.exists() {
            return Ok(false);
        }
        let path = if journal.exists() { &journal } else { &temp };
        eprintln!("[store] completing interrupted wipe");
        self.write_wipe_tombstones()?;
        self.cleanup_after_wipe()?;
        remove_if_exists(self.save_journal_path())?;
        remove_if_exists(self.save_journal_path().with_extension("tmp"))?;
        remove_if_exists(path)?;
        remove_if_exists(journal)?;
        remove_if_exists(temp)?;
        Ok(true)
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn recover_pending_save_guarded(&self) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()
    }

    pub fn snapshot(&self) -> Value {
        let _guard = match self.lock_writes() {
            Ok(guard) => guard,
            Err(error) => return add_snapshot_error(empty_snapshot(self.dir()), error),
        };
        if let Err(error) = self.recover_pending_save() {
            return add_snapshot_error(empty_snapshot(self.dir()), format!("recovery: {error}"));
        }
        self.snapshot_unlocked()
    }

    pub fn snapshot_unacknowledged(&self) -> Value {
        let _guard = match self.lock_writes() {
            Ok(guard) => guard,
            Err(error) => return add_snapshot_error(empty_snapshot(self.dir()), error),
        };
        if let Err(error) = self.recover_pending_save() {
            return add_snapshot_error(empty_snapshot(self.dir()), format!("recovery: {error}"));
        }
        let dir = self.dir();
        let mut snapshot = match record_files::load_records(&dir) {
            Ok(records) if records.is_empty() => empty_snapshot(dir.clone()),
            Ok(records) => snapshot_payload(&dir, &records),
            Err(error) => {
                add_snapshot_error(empty_snapshot(dir.clone()), format!("records: {error}"))
            }
        };
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &dir);
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        snapshot
    }

    pub fn acknowledge_frontend_snapshot(&self, payload: &Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        validate_snapshot_payload_schema(payload)?;
        let previous = self.base_records.lock().unwrap().clone();
        let now = record_files::now_millis();
        let mut incoming = record_files::payload_to_records(payload, self.device_id(), now);
        self.hydrate_text_records(&mut incoming)?;
        let incoming_fingerprints = record_files::fingerprints(&incoming);
        let current = record_files::load_records(&self.dir())?;
        *self.base_records.lock().unwrap() =
            acknowledged_frontend_base(&previous, &incoming_fingerprints, &current);
        Ok(())
    }

    pub(crate) fn snapshot_unlocked(&self) -> Value {
        let mut snapshot = match self.records_snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                add_snapshot_error(empty_snapshot(self.dir()), format!("records: {error}"))
            }
        };
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &self.dir());
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        snapshot
    }

    pub fn bulk_save(&self, payload: Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        match self.recover_pending_operations()? {
            PendingRecovery::None => {}
            PendingRecovery::Save => {
                self.base_records.lock().unwrap().clear();
            }
            PendingRecovery::Wipe => {
                return Err("pending wipe was recovered; reload before saving".to_string());
            }
        }
        validate_snapshot_payload_schema(&payload)?;
        let base = self.base_records.lock().unwrap().clone();
        let saved_at = record_files::now_millis();
        let journal = self.save_journal_path();
        durable::write_json_atomic(
            &journal,
            &encode_save_journal(&payload, &base, saved_at),
            false,
            false,
        )?;

        self.commit_bulk_save_with_context(&payload, &base, saved_at)?;
        remove_if_exists(journal)
    }

    fn commit_bulk_save_with_context(
        &self,
        payload: &Value,
        base: &record_files::Fingerprints,
        now: u128,
    ) -> Result<(), String> {
        validate_snapshot_payload_schema(payload)?;
        let mut incoming = record_files::payload_to_records(payload, self.device_id(), now);
        self.hydrate_text_records(&mut incoming)?;
        let current = record_files::load_records(&self.dir())?;
        record_files::prepare_local_records(&mut incoming, base, self.device_id(), now);
        let incoming_fingerprints = record_files::fingerprints(&incoming);
        let merged = record_files::merge_records(base, incoming, current, self.device_id(), now);
        record_files::write_records(&self.dir(), &merged.records)?;
        record_files::write_conflicts(&self.dir(), &merged.conflicts)?;
        *self.base_records.lock().unwrap() =
            acknowledged_frontend_base(base, &incoming_fingerprints, &merged.records);
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn seed_or_refresh_records(&self) -> Result<(), String> {
        self.records_snapshot().map(|_| ())
    }

    pub fn sync_with_directory(&self, sync_dir: PathBuf) -> Result<Value, String> {
        self.sync_with_directory_inner(sync_dir)
    }

    fn sync_with_directory_inner(&self, sync_dir: PathBuf) -> Result<Value, String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        std::fs::create_dir_all(&sync_dir).map_err(|e| e.to_string())?;

        let local_dir = self.dir();
        record_files::prune_sync_folder_private_records(&sync_dir)?;
        self.write_sync_journal(&sync_dir, "start")?;
        self.write_sync_journal(&sync_dir, "snapshotted-local")?;
        let now = record_files::now_millis();
        record_files::ingest_syncthing_conflict_copies(&sync_dir, self.device_id())?;

        let local_records = record_files::load_sync_records(&local_dir)?;
        let remote_records = record_files::load_sync_records(&sync_dir)?;
        let merged = record_files::merge_records(
            &BTreeMap::new(),
            local_records,
            remote_records,
            self.device_id(),
            now,
        );

        record_files::sync_resolved_conflict_markers(&local_dir, &sync_dir)?;
        self.write_sync_journal(&sync_dir, "merged-records")?;
        record_files::write_records(&local_dir, &merged.records)?;
        record_files::write_conflicts(&local_dir, &merged.conflicts)?;
        self.write_sync_journal(&sync_dir, "wrote-local-records")?;
        record_files::write_records(&sync_dir, &merged.records)?;
        record_files::write_conflicts(&sync_dir, &merged.conflicts)?;
        self.write_sync_journal(&sync_dir, "wrote-remote-records")?;

        copy_media_assets(&sync_dir, &local_dir, self.device_id())?;
        self.write_sync_journal(&sync_dir, "synced-media")?;

        let applied_records = record_files::load_records(&local_dir)?;
        let applied_sync_records = record_files::sync_records(&applied_records);
        record_files::write_records(&sync_dir, &applied_sync_records)?;
        record_files::prune_sync_folder_private_records(&sync_dir)?;
        self.write_sync_journal(&sync_dir, "verified-records")?;
        let mut snapshot = snapshot_payload(&local_dir, &applied_records);
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &local_dir);
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        self.clear_sync_journal()?;
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
        status["pendingWipeJournalTemp"] =
            Value::Bool(self.wipe_journal_path().with_extension("tmp").exists());
        status["pendingSyncJournal"] = Value::Bool(self.sync_journal_path().exists());
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
        record_files::resolve_conflict(
            &dir,
            id,
            use_conflict,
            self.device_id(),
            record_files::now_millis(),
        )?;
        let records = record_files::load_records(&dir)?;
        let mut snapshot = snapshot_payload(&dir, &records);
        add_sync_dir_to_snapshot(&mut snapshot);
        add_sync_status_to_snapshot(&mut snapshot, &dir);
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        Ok(snapshot)
    }

    fn records_snapshot(&self) -> Result<Value, String> {
        let dir = self.dir();
        let records = record_files::load_records(&dir)?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        if records.is_empty() {
            return Ok(empty_snapshot(dir));
        }
        Ok(snapshot_payload(&dir, &records))
    }

    pub fn wipe(&self) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        self.write_wipe_journal()?;
        self.write_wipe_tombstones()?;
        self.cleanup_after_wipe()?;
        self.discard_abandoned_book_imports()?;
        remove_if_exists(self.wipe_journal_path())?;
        Ok(())
    }

    fn write_wipe_journal(&self) -> Result<(), String> {
        let journal = self.wipe_journal_path();
        durable::write_json_atomic(
            &journal,
            &json!({
                "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
                "op": "wipe",
                "deviceId": self.device_id(),
                "createdAt": record_files::now_millis().to_string(),
            }),
            false,
            false,
        )
    }

    fn write_wipe_tombstones(&self) -> Result<(), String> {
        let records = record_files::tombstone_all(&self.dir(), self.device_id())?;
        media_assets::tombstone_all(&self.dir(), self.device_id())?;
        *self.base_records.lock().unwrap() = record_files::fingerprints(&records);
        Ok(())
    }

    fn cleanup_after_wipe(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        record_files::remove_record_backups(&inner.dir)?;
        let import_staging = inner.dir.join("ocr-import-staging");
        if import_staging.exists() {
            std::fs::remove_dir_all(&import_staging).map_err(|e| e.to_string())?;
            durable::sync_parent(&import_staging)?;
        }
        Ok(())
    }

    fn write_sync_journal(&self, sync_dir: &Path, phase: &str) -> Result<(), String> {
        let journal = self.sync_journal_path();
        durable::write_json_atomic(
            &journal,
            &json!({
                "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
                "op": "sync",
                "phase": phase,
                "syncDir": sync_dir,
                "deviceId": self.device_id(),
                "updatedAt": record_files::now_millis().to_string(),
            }),
            true,
            true,
        )
    }

    fn clear_sync_journal(&self) -> Result<(), String> {
        remove_if_exists(self.sync_journal_path())
    }
}

fn quarantine_journal(path: &Path) -> Result<(), String> {
    let bad = path.with_extension("bad");
    let _ = durable::remove_file_if_exists(&bad);
    std::fs::rename(path, &bad).map_err(|e| e.to_string())?;
    durable::sync_parent(&bad)
}

fn remove_if_exists(path: impl AsRef<Path>) -> Result<(), String> {
    durable::remove_file_if_exists(path.as_ref())
}

fn validate_snapshot_payload_schema(payload: &Value) -> Result<(), String> {
    let schema_version = payload
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "schemaVersion is missing".to_string())?;
    if schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(format!("unsupported schemaVersion: {schema_version}"));
    }
    Ok(())
}

fn encode_save_journal(
    payload: &Value,
    base: &record_files::Fingerprints,
    saved_at: u128,
) -> Value {
    let base_records = base
        .iter()
        .map(|(key, fingerprint)| {
            (
                key.clone(),
                json!({
                    "hash": fingerprint.hash,
                    "causal": fingerprint.causal,
                }),
            )
        })
        .collect::<Map<String, Value>>();
    json!({
        "journalFormat": SAVE_JOURNAL_FORMAT,
        "savedAt": saved_at.to_string(),
        "baseRecords": base_records,
        "payload": payload,
    })
}

fn decode_save_journal(
    journal: &Value,
    legacy_base: record_files::Fingerprints,
) -> Result<(Value, record_files::Fingerprints, u128), String> {
    if journal.get("journalFormat").is_none() {
        validate_snapshot_payload_schema(journal)?;
        return Ok((journal.clone(), legacy_base, record_files::now_millis()));
    }
    let format = journal
        .get("journalFormat")
        .and_then(Value::as_u64)
        .ok_or_else(|| "save journal format is invalid".to_string())?;
    if format != SAVE_JOURNAL_FORMAT {
        return Err(format!("unsupported save journal format: {format}"));
    }
    let payload = journal
        .get("payload")
        .cloned()
        .ok_or_else(|| "save journal payload is missing".to_string())?;
    validate_snapshot_payload_schema(&payload)?;
    let saved_at = journal
        .get("savedAt")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|text| text.parse::<u128>().ok())
                .or_else(|| value.as_u64().map(u128::from))
        })
        .ok_or_else(|| "save journal timestamp is invalid".to_string())?;
    let base_values = journal
        .get("baseRecords")
        .and_then(Value::as_object)
        .ok_or_else(|| "save journal base is invalid".to_string())?;
    let mut base = record_files::Fingerprints::new();
    for (key, value) in base_values {
        let hash = value
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("save journal base hash is invalid for {key}"))?;
        let causal_values = value
            .get("causal")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("save journal causal clock is invalid for {key}"))?;
        let causal = causal_values
            .iter()
            .map(|(device, counter)| {
                counter
                    .as_u64()
                    .map(|counter| (device.clone(), counter))
                    .ok_or_else(|| format!("save journal causal value is invalid for {key}"))
            })
            .collect::<Result<_, _>>()?;
        base.insert(
            key.clone(),
            record_files::RecordFingerprint {
                hash: hash.to_string(),
                causal,
            },
        );
    }
    Ok((payload, base, saved_at))
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

fn copy_media_assets(sync_dir: &Path, local_dir: &Path, device_id: &str) -> Result<(), String> {
    media_assets::sync_book_assets(local_dir, sync_dir, device_id)?;
    copy_tree_filtered(
        &sync_dir.join("argos-packages"),
        &local_dir.join("argos-packages"),
    )?;
    copy_tree_filtered(
        &local_dir.join("argos-packages"),
        &sync_dir.join("argos-packages"),
    )
}

fn copy_tree_filtered(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if source.is_dir() {
            copy_tree_filtered(&source, &target)?;
        } else if source.is_file() && should_copy_file(&source, &target)? {
            durable::copy_file_atomic(&source, &target, false)?;
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

fn acknowledged_frontend_base(
    previous: &record_files::Fingerprints,
    incoming: &record_files::Fingerprints,
    merged: &BTreeMap<String, record_files::SyncRecord>,
) -> record_files::Fingerprints {
    let merged_fingerprints = record_files::fingerprints(merged);
    let mut next = previous.clone();
    let known_keys = previous
        .keys()
        .chain(incoming.keys())
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();

    for key in known_keys {
        match incoming.get(&key) {
            Some(incoming_record) => {
                if let Some(merged_record) = merged_fingerprints
                    .get(&key)
                    .filter(|record| record.hash == incoming_record.hash)
                {
                    next.insert(key, merged_record.clone());
                }
            }
            None => {
                let deletion_was_applied = merged
                    .get(&key)
                    .map(|record| record.deleted_at.is_some())
                    .unwrap_or(true);
                if deletion_was_applied {
                    next.remove(&key);
                }
            }
        }
    }
    next
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier, Mutex, mpsc};
    use std::time::Duration;

    use serde_json::{Map, Value, json};

    use crate::store::snapshot::{SNAPSHOT_SCHEMA_VERSION, encode_save_journal};
    use crate::store::{Store, StoreInner, record_files};

    fn store_at(dir: &tempfile::TempDir) -> Store {
        store_at_with_device(dir, "test-device")
    }

    fn store_at_with_device(dir: &tempfile::TempDir, device_id: &str) -> Store {
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
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
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
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
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
    fn repeated_stale_save_keeps_cloud_record_this_app_did_not_see() {
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

        store.bulk_save(original.clone()).unwrap();
        store.bulk_save(original).unwrap();

        assert_eq!(
            store.snapshot()["vocab"]["de"]["vocab"]["neu"]["translation"],
            "new"
        );
    }

    #[test]
    fn repeated_stale_save_keeps_newer_cloud_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        let original = profile_payload("wort", "old");
        store.bulk_save(original.clone()).unwrap();
        let _ = store.snapshot();

        let cloud_payload = profile_payload("wort", "new");
        let cloud_record = record_files::payload_to_records(&cloud_payload, "cloud-device", 1)
            .remove("vocab:de:wort")
            .unwrap();
        let mut records = record_files::load_records(dir.path()).unwrap();
        records.insert(cloud_record.key.clone(), cloud_record);
        record_files::write_records(dir.path(), &records).unwrap();

        store.bulk_save(original.clone()).unwrap();
        store.bulk_save(original).unwrap();

        assert_eq!(
            store.snapshot()["vocab"]["de"]["vocab"]["wort"]["translation"],
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
        store
            .bulk_save(profile_payload("wort", "newer-local"))
            .unwrap();

        let snapshot = store.resolve_sync_conflict(&id, "keep-current").unwrap();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["wort"]["translation"],
            "newer-local"
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
        store
            .bulk_save(profile_payload("wort", "newer-local"))
            .unwrap();
        let current_causal = record_files::load_records(dir.path()).unwrap()["vocab:de:wort"]
            .causal
            .clone();

        let snapshot = store.resolve_sync_conflict(&id, "use-conflict").unwrap();
        let resolved = record_files::load_records(dir.path()).unwrap();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["wort"]["translation"],
            "cloud"
        );
        for (device, counter) in current_causal {
            assert!(resolved["vocab:de:wort"].causal.get(&device) >= Some(&counter));
        }
        assert_eq!(store.sync_status()["conflictCount"].as_u64(), Some(0));
    }

    #[test]
    fn resolved_conflict_marker_prunes_remote_conflict_on_next_sync() {
        let pc = tempfile::tempdir().unwrap();
        let phone = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let pc_store = store_at_with_device(&pc, "pc-device");
        let phone_store = store_at_with_device(&phone, "phone-device");
        pc_store.bulk_save(profile_payload("wort", "base")).unwrap();
        pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        phone_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        pc_store.bulk_save(profile_payload("wort", "pc")).unwrap();
        phone_store
            .bulk_save(profile_payload("wort", "phone"))
            .unwrap();
        phone_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        assert_eq!(pc_store.sync_status()["conflictCount"].as_u64(), Some(1));
        assert_eq!(record_files::conflict_count(remote.path()).unwrap(), 1);

        let id = pc_store.sync_status()["conflicts"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let resolved = pc_store.resolve_sync_conflict(&id, "use-conflict").unwrap();
        let selected_translation = resolved["vocab"]["de"]["vocab"]["wort"]["translation"]
            .as_str()
            .unwrap()
            .to_string();
        pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        phone_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let converged = pc_store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert_eq!(pc_store.sync_status()["conflictCount"].as_u64(), Some(0));
        assert_eq!(phone_store.sync_status()["conflictCount"].as_u64(), Some(0));
        assert_eq!(record_files::conflict_count(remote.path()).unwrap(), 0);
        assert_eq!(
            converged["vocab"]["de"]["vocab"]["wort"]["translation"],
            selected_translation
        );
        assert!(remote.path().join("records/v1/resolved-conflicts").is_dir());
    }

    #[test]
    fn store_mutations_wait_for_global_write_lock() {
        let dir = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = Arc::new(store_at(&dir));
        let guard = store.lock_writes().unwrap();
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (attempting_tx, attempting_rx) = mpsc::channel();
        let start = Arc::new(Barrier::new(7));

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
            let ready_tx = ready_tx.clone();
            let attempting_tx = attempting_tx.clone();
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                ready_tx.send(name).unwrap();
                start.wait();
                attempting_tx.send(name).unwrap();
                let result = task();
                tx.send((name, result)).unwrap();
            });
        }

        {
            let store = Arc::clone(&store);
            let remote = remote.path().to_path_buf();
            let tx = tx.clone();
            let ready_tx = ready_tx.clone();
            let attempting_tx = attempting_tx.clone();
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                ready_tx.send("sync_with_directory").unwrap();
                start.wait();
                attempting_tx.send("sync_with_directory").unwrap();
                let result = store.sync_with_directory(remote).map(|_| ());
                tx.send(("sync_with_directory", result)).unwrap();
            });
        }

        for _ in 0..6 {
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        start.wait();
        for _ in 0..6 {
            attempting_rx.recv_timeout(Duration::from_secs(5)).unwrap();
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
    fn recover_pending_wipe_completes_tombstones_before_save_recovery() {
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
    fn snapshot_recovers_pending_save_before_first_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&profile_payload("ocalony", "saved")).unwrap(),
        )
        .unwrap();

        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["ocalony"]["translation"],
            "saved"
        );
        assert!(!store.save_journal_path().exists());
    }

    #[test]
    fn versioned_save_journal_recovers_a_deletion_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store
            .bulk_save(profile_payload("usun", "delete me"))
            .unwrap();
        let _ = store.snapshot();
        let base = store.base_records.lock().unwrap().clone();
        let journal = encode_save_journal(&profile_payload_words(&[]), &base, 10);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let recovered = store_at(&dir);
        recovered.recover_pending_save().unwrap();

        let records = record_files::load_records(dir.path()).unwrap();
        assert!(records["vocab:de:usun"].deleted_at.is_some());
        assert!(
            recovered.snapshot()["vocab"]["de"]["vocab"]
                .get("usun")
                .is_none()
        );
    }

    #[test]
    fn versioned_save_journal_keeps_its_original_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("wort", "base")).unwrap();
        let _ = store.snapshot();
        let base = store.base_records.lock().unwrap().clone();
        let journal = encode_save_journal(&profile_payload("wort", "stale local"), &base, 10);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        let cloud_payload = profile_payload("wort", "new cloud");
        let mut cloud_record = record_files::payload_to_records(&cloud_payload, "cloud-device", 20)
            .remove("vocab:de:wort")
            .unwrap();
        cloud_record.updated_at = 20;
        record_files::write_records(
            dir.path(),
            &BTreeMap::from([(cloud_record.key.clone(), cloud_record)]),
        )
        .unwrap();

        let recovered = store_at(&dir);
        recovered.recover_pending_save().unwrap();

        assert_eq!(
            recovered.snapshot()["vocab"]["de"]["vocab"]["wort"]["translation"],
            "new cloud"
        );
    }

    #[test]
    fn snapshot_reports_pending_recovery_journals() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(store.save_journal_path(), "{}").unwrap();
        std::fs::write(store.save_journal_path().with_extension("tmp"), "{}").unwrap();
        std::fs::write(store.wipe_journal_path(), "{}").unwrap();
        std::fs::write(store.wipe_journal_path().with_extension("tmp"), "{}").unwrap();
        std::fs::write(dir.path().join("save-journal.bad"), "{").unwrap();

        let status = store.recovery_status();

        assert_eq!(status["pendingSaveJournal"], true);
        assert_eq!(status["pendingSaveJournalTemp"], true);
        assert_eq!(status["pendingWipeJournal"], true);
        assert_eq!(status["pendingWipeJournalTemp"], true);
        assert_eq!(status["quarantinedSaveJournal"], true);
    }

    #[test]
    fn bulk_save_recovers_pending_journal_without_treating_it_as_seen_base() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&profile_payload("stary", "stale")).unwrap(),
        )
        .unwrap();

        store.bulk_save(profile_payload("nowy", "new")).unwrap();
        let snapshot = store.snapshot();

        assert!(!dir.path().join("save-journal.bad").is_file());
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["stary"]["translation"],
            "stale"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["nowy"]["translation"],
            "new"
        );
        assert!(!store.save_journal_path().exists());
    }

    #[test]
    fn bulk_save_rejects_future_payload_schema_without_overwriting_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("alt", "old")).unwrap();
        let mut future = profile_payload("neu", "new");
        future["schemaVersion"] = Value::from(SNAPSHOT_SCHEMA_VERSION + 1);

        let error = store.bulk_save(future).unwrap_err();
        let snapshot = store.snapshot();

        assert!(error.contains("unsupported schemaVersion"));
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["alt"]["translation"],
            "old"
        );
        assert!(snapshot["vocab"]["de"]["vocab"]["neu"].is_null());
    }

    #[test]
    fn recovered_pending_wipe_blocks_stale_first_save() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(profile_payload("alt", "old")).unwrap();
        store.write_wipe_journal().unwrap();

        let error = store
            .bulk_save(profile_payload("revived", "bad"))
            .unwrap_err();
        let snapshot = store.snapshot();

        assert!(error.contains("pending wipe was recovered"));
        assert!(snapshot["vocab"]["de"]["vocab"]["alt"].is_null());
        assert!(snapshot["vocab"]["de"]["vocab"]["revived"].is_null());
        assert!(!store.wipe_journal_path().exists());
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
    fn save_from_an_unacknowledged_frontend_keeps_records_imported_by_sync() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store
            .bulk_save(profile_payload("lokal", "before-sync"))
            .unwrap();

        let remote_payload = profile_payload("fern", "remote");
        let remote_records = record_files::payload_to_records(&remote_payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();
        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let _ = store.snapshot_unacknowledged();

        store
            .bulk_save(profile_payload("lokal", "after-sync"))
            .unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "after-sync"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["fern"]["translation"],
            "remote"
        );
    }

    #[test]
    fn acknowledged_sync_snapshot_becomes_the_frontend_merge_base() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store.bulk_save(profile_payload("lokal", "local")).unwrap();

        let remote_payload = profile_payload("fern", "remote");
        let remote_records = record_files::payload_to_records(&remote_payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();
        let mut snapshot = store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        store.acknowledge_frontend_snapshot(&snapshot).unwrap();
        snapshot["vocab"]["de"]["vocab"]["fern"]["translation"] = json!("edited");

        store.bulk_save(snapshot).unwrap();
        let saved = store.snapshot();

        assert_eq!(
            saved["vocab"]["de"]["vocab"]["fern"]["translation"],
            "edited"
        );
        assert_eq!(saved["syncConflictCount"].as_u64(), Some(0));
    }

    #[test]
    fn sync_directory_keeps_preferences_local_and_out_of_sync_folder() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        let mut local_payload = profile_payload("lokal", "local");
        local_payload["prefs"]["locale"] = json!("pl");
        store.bulk_save(local_payload).unwrap();

        let mut remote_payload = profile_payload("fern", "remote");
        remote_payload["prefs"]["locale"] = json!("en");
        let remote_records = record_files::payload_to_records(&remote_payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();

        let snapshot = store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        let local_records = record_files::load_records(local.path()).unwrap();
        let remote_records = record_files::load_records(remote.path()).unwrap();

        assert_eq!(snapshot["prefs"]["locale"], "pl");
        assert!(local_records.contains_key("pref:locale"));
        assert!(!remote_records.contains_key("pref:locale"));
        assert!(!remote_records.contains_key("pref:learningLanguage"));
        assert!(!remote.path().join("records/v1/prefs").exists());
    }

    #[test]
    fn sync_directory_recovers_pending_save_before_first_merge() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        std::fs::write(
            store.save_journal_path(),
            serde_json::to_vec(&profile_payload("lokal", "local")).unwrap(),
        )
        .unwrap();
        let remote_payload = profile_payload("fern", "remote");
        let remote_records = record_files::payload_to_records(&remote_payload, "remote-device", 2);
        record_files::write_records(remote.path(), &remote_records).unwrap();

        let snapshot = store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "local"
        );
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["fern"]["translation"],
            "remote"
        );
        assert!(!store.save_journal_path().exists());
    }

    #[test]
    fn sync_directory_clears_resumed_sync_journal_after_idempotent_retry() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store.bulk_save(profile_payload("lokal", "local")).unwrap();
        store
            .write_sync_journal(remote.path(), "wrote-local-records")
            .unwrap();

        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert!(!store.sync_journal_path().exists());
        let remote_records = record_files::load_records(remote.path()).unwrap();
        assert!(remote_records.contains_key("vocab:de:lokal"));
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
    fn sync_directory_copies_remote_book_media() {
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
        let local_records = record_files::load_records(local.path()).unwrap();
        assert_eq!(local_records["text:de-custom-media"].data["title"], "Media");
    }

    #[test]
    fn sync_directory_uses_asset_hash_when_same_size_content_differs() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store
            .save_book_image_bytes("de-custom-media", "cover.jpg", b"aaaa")
            .unwrap();
        let remote_image_dir = remote.path().join("books/de-custom-media/images");
        std::fs::create_dir_all(&remote_image_dir).unwrap();
        std::fs::write(remote_image_dir.join("cover.jpg"), b"bbbb").unwrap();

        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert_eq!(
            std::fs::read(local.path().join("books/de-custom-media/images/cover.jpg")).unwrap(),
            b"bbbb"
        );
    }

    #[test]
    fn sync_directory_propagates_book_media_tombstones() {
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let store = store_at(&local);
        store
            .save_book_image_bytes("de-custom-media", "cover.jpg", b"cover")
            .unwrap();
        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();
        assert!(
            remote
                .path()
                .join("books/de-custom-media/images/cover.jpg")
                .is_file()
        );

        store.delete_text("de-custom-media").unwrap();
        store
            .sync_with_directory(remote.path().to_path_buf())
            .unwrap();

        assert!(
            !remote
                .path()
                .join("books/de-custom-media/images/cover.jpg")
                .exists()
        );
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

fn empty_snapshot(dir: PathBuf) -> Value {
    json!({
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "dataDir": dir,
        "texts": [],
        "prefs": {},
        "hiddenBooks": [],
        "vocab": {},
        "errors": [],
    })
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
        let current = record_files::load_records(&self.dir())?;
        for record in records.values_mut().filter(|record| record.kind == "text") {
            let has_text = record.data.get("text").and_then(Value::as_str).is_some();
            if has_text {
                continue;
            }
            let Some(text) = current
                .get(&record.key)
                .filter(|current| current.deleted_at.is_none())
                .and_then(|current| current.data.get("text"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if let Some(obj) = record.data.as_object_mut() {
                obj.insert("text".to_string(), Value::String(text.to_string()));
            }
        }
        Ok(())
    }
}
