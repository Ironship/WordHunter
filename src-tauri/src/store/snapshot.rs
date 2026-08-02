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
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dir
            .join("save-journal.json")
    }

    fn wipe_journal_path(&self) -> std::path::PathBuf {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dir
            .join("wipe-journal.json")
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
            let current_base = self
                .base_records
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
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

    #[allow(dead_code)]
    pub(crate) fn recover_pending_save_guarded(&self) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()
    }

    #[cfg(target_os = "android")]
    pub(crate) fn recover_android_startup_guarded(&self) -> Result<(), String> {
        {
            let _guard = self.lock_writes()?;
            self.recover_pending_save()?;
            record_files::migrate_legacy_json_records(&self.dir())?;
        }
        self.discard_abandoned_book_imports()
    }

    pub fn snapshot(&self) -> Value {
        self.snapshot_with_recovery_status(true)
    }

    fn snapshot_with_recovery_status(&self, include_recovery_status: bool) -> Value {
        let _guard = match self.lock_writes() {
            Ok(guard) => guard,
            Err(error) => return add_snapshot_error(empty_snapshot(self.dir()), error),
        };
        if let Err(error) = self.recover_pending_save() {
            return add_snapshot_error(empty_snapshot(self.dir()), format!("recovery: {error}"));
        }
        self.snapshot_unlocked(include_recovery_status)
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
        add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        snapshot
    }

    pub fn acknowledge_frontend_snapshot(&self, payload: &Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        validate_snapshot_payload_schema(payload)?;
        let previous = self
            .base_records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let now = record_files::now_millis();
        let mut incoming = record_files::payload_to_records(payload, self.device_id(), now);
        self.hydrate_text_records(&mut incoming)?;
        let incoming_fingerprints = record_files::fingerprints(&incoming);
        let current = record_files::load_records(&self.dir())?;
        *self.base_records.lock().unwrap_or_else(|e| e.into_inner()) =
            acknowledged_frontend_base(&previous, &incoming_fingerprints, &current);
        Ok(())
    }

    fn snapshot_unlocked(&self, include_recovery_status: bool) -> Value {
        let mut snapshot = match self.records_snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                add_snapshot_error(empty_snapshot(self.dir()), format!("records: {error}"))
            }
        };
        if include_recovery_status {
            add_recovery_status_to_snapshot(&mut snapshot, self.recovery_status());
        }
        snapshot
    }

    pub fn bulk_save(&self, payload: Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        match self.recover_pending_operations()? {
            PendingRecovery::None => {}
            PendingRecovery::Save => {
                self.base_records
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clear();
            }
            PendingRecovery::Wipe => {
                return Err("pending wipe was recovered; reload before saving".to_string());
            }
        }
        validate_snapshot_payload_schema(&payload)?;
        let base = self
            .base_records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let saved_at = record_files::now_millis();
        let mut incoming = record_files::payload_to_records(&payload, self.device_id(), saved_at);
        self.hydrate_text_records(&mut incoming)?;
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

    pub fn restore_backup(&self, payload: Value) -> Result<(), String> {
        let _guard = self.lock_writes()?;
        if self.recover_pending_wipe()? {
            self.base_records
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
        validate_snapshot_payload_schema(&payload)?;
        let current = record_files::load_records(&self.dir())?;
        let base = record_files::fingerprints(&current);
        let saved_at = record_files::now_millis();
        let mut incoming = record_files::payload_to_records(&payload, self.device_id(), saved_at);
        self.hydrate_text_records(&mut incoming)?;
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
        record_files::prepare_local_records(&mut incoming, base, &current, self.device_id(), now);
        let incoming_fingerprints = record_files::fingerprints(&incoming);
        let merged = record_files::merge_records(base, incoming, current, self.device_id(), now);
        record_files::write_records(&self.dir(), &merged.records)?;
        *self.base_records.lock().unwrap_or_else(|e| e.into_inner()) =
            acknowledged_frontend_base(base, &incoming_fingerprints, &merged.records);
        Ok(())
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
        status["quarantinedSaveJournal"] = Value::Bool(dir.join("save-journal.bad").exists());
        status
    }

    fn records_snapshot(&self) -> Result<Value, String> {
        let dir = self.dir();
        let records = record_files::load_records(&dir)?;
        *self.base_records.lock().unwrap_or_else(|e| e.into_inner()) =
            record_files::fingerprints(&records);
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
        *self.base_records.lock().unwrap_or_else(|e| e.into_inner()) =
            record_files::fingerprints(&records);
        Ok(())
    }

    fn cleanup_after_wipe(&self) -> Result<(), String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        record_files::remove_record_backups(&inner.dir)?;
        let ui_state = inner.dir.join(super::UI_STATE_FILE);
        remove_if_exists(&ui_state)?;
        remove_if_exists(ui_state.with_extension("tmp"))?;
        remove_if_exists(ui_state.with_extension("bak"))?;
        let import_staging = inner.dir.join("ocr-import-staging");
        if import_staging.exists() {
            std::fs::remove_dir_all(&import_staging).map_err(|e| e.to_string())?;
            durable::sync_parent(&import_staging)?;
        }
        Ok(())
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
                    "data": fingerprint.data,
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
                data: value.get("data").cloned().filter(|value| !value.is_null()),
            },
        );
    }
    Ok((payload, base, saved_at))
}

fn add_recovery_status_to_snapshot(snapshot: &mut Value, status: Value) {
    snapshot["recoveryStatus"] = status;
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
        let needs_hydration = records.values().any(|record| {
            record.kind == "text"
                && (record.data.get("text").and_then(Value::as_str).is_none()
                    || (record.data.get("pdfOcrPageCount").and_then(Value::as_u64) > Some(0)
                        && record.data.get("pdfOcrPages").is_none()))
        });
        if !needs_hydration {
            return Ok(());
        }
        let current = record_files::load_records(&self.dir())?;
        for record in records.values_mut().filter(|record| record.kind == "text") {
            let has_text = record.data.get("text").and_then(Value::as_str).is_some();
            let pages_are_deferred = record.data.get("pdfOcrPageCount").and_then(Value::as_u64)
                > Some(0)
                && record.data.get("pdfOcrPages").is_none();
            if has_text && !pages_are_deferred {
                continue;
            }
            let current_record = current
                .get(&record.key)
                .filter(|current| current.deleted_at.is_none())
                .ok_or_else(|| {
                    format!(
                        "cannot hydrate projected text record {}; retry after the record is readable",
                        record.key
                    )
                })?;
            let obj = record
                .data
                .as_object_mut()
                .ok_or_else(|| format!("text record {} data is not an object", record.key))?;
            if !has_text {
                let text = current_record
                    .data
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("text record {} has no durable body", record.key))?;
                obj.insert("text".to_string(), Value::String(text.to_string()));
            }
            if pages_are_deferred {
                let pages = current_record
                    .data
                    .get("pdfOcrPages")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        format!("text record {} has no durable PDF pages", record.key)
                    })?;
                obj.insert("pdfOcrPages".to_string(), Value::Array(pages.clone()));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::store::{StoreInner, record_files};

    fn store_at(dir: &tempfile::TempDir) -> Store {
        std::fs::create_dir_all(dir.path().join("books")).unwrap();
        Store {
            inner: Mutex::new(StoreInner {
                dir: dir.path().to_path_buf(),
                books_dir: dir.path().join("books"),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: "snapshot-test".to_string(),
            startup_instant: std::time::Instant::now(),
        }
    }

    fn payload(word: &str) -> Value {
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
                    "vocab": {
                        word: { "word": word, "translation": "word", "status": "learning" }
                    }
                }
            }
        })
    }

    #[test]
    fn bulk_save_roundtrips_yaml_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(payload("Wort")).unwrap();

        let snapshot = store.snapshot();
        assert_eq!(
            snapshot["vocab"]["de"]["vocab"]["wort"]["translation"],
            "word"
        );
        let records = record_files::load_records(dir.path()).unwrap();
        assert!(records.contains_key("vocab:de:wort"));
        assert!(
            std::fs::read_dir(dir.path().join("records/v1/vocab"))
                .unwrap()
                .flatten()
                .any(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("yaml")
                )
        );
    }

    #[test]
    fn wipe_removes_saved_words() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        store.bulk_save(payload("Wort")).unwrap();
        store.wipe().unwrap();
        assert!(
            record_files::load_records(dir.path())
                .unwrap()
                .values()
                .all(|record| record.deleted_at.is_some())
        );
    }
}
