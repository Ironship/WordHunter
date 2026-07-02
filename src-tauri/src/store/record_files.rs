use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FORMAT: u64 = 1;
const PAYLOAD_SCHEMA_VERSION: u64 = 2;
const ROOT: &str = "records";
const VERSION: &str = "v1";
static LAST_CLOCK_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct SyncRecord {
    pub key: String,
    pub kind: String,
    pub data: Value,
    pub updated_at: u128,
    pub deleted_at: Option<u128>,
    pub device_id: String,
    pub causal: CausalClock,
}

pub(crate) type CausalClock = BTreeMap<String, u64>;

#[derive(Clone, Debug)]
pub(crate) struct RecordFingerprint {
    pub hash: String,
    pub causal: CausalClock,
}

pub(crate) type Fingerprints = BTreeMap<String, RecordFingerprint>;

pub(crate) struct MergeResult {
    pub records: BTreeMap<String, SyncRecord>,
    pub conflicts: Vec<Value>,
}

pub(crate) fn now_millis() -> u128 {
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
        .min(u128::from(u64::MAX)) as u64;
    let mut previous = LAST_CLOCK_MS.load(Ordering::Relaxed);
    loop {
        let next = wall.max(previous.saturating_add(1));
        match LAST_CLOCK_MS.compare_exchange(previous, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return u128::from(next),
            Err(actual) => previous = actual,
        }
    }
}

pub(crate) fn records_root(dir: &Path) -> PathBuf {
    dir.join(ROOT).join(VERSION)
}

pub(crate) fn has_records(dir: &Path) -> bool {
    let root = records_root(dir);
    ["profiles", "vocab", "texts", "prefs", "hidden", "books"]
        .iter()
        .any(|name| root.join(name).is_dir())
}

pub(crate) fn load_records(dir: &Path) -> Result<BTreeMap<String, SyncRecord>, String> {
    let root = records_root(dir);
    let mut records = BTreeMap::new();
    if !root.exists() {
        return Ok(records);
    }
    for kind_dir in ["profiles", "vocab", "texts", "prefs", "hidden", "books"] {
        let dir = root.join(kind_dir);
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let is_json = path.extension().and_then(|value| value.to_str()) == Some("json");
            let is_backup = path.extension().and_then(|value| value.to_str()) == Some("bak");
            let path = if is_json {
                path
            } else if is_backup {
                let primary = path.with_extension("json");
                if primary.exists() {
                    continue;
                }
                primary
            } else {
                continue;
            };
            match read_record_file(&path) {
                Ok(record) => {
                    records.insert(record.key.clone(), record);
                }
                Err(error) => {
                    // Cloud sync can briefly expose a zero-byte file; skip one bad record instead of killing startup.
                    eprintln!("{error}");
                }
            }
        }
    }
    Ok(records)
}

pub(crate) fn write_records(
    dir: &Path,
    records: &BTreeMap<String, SyncRecord>,
) -> Result<(), String> {
    for record in records.values() {
        write_record_with_backup(dir, record, true)?;
    }
    Ok(())
}

pub(crate) fn write_conflicts(dir: &Path, conflicts: &[Value]) -> Result<(), String> {
    if conflicts.is_empty() {
        return Ok(());
    }
    let dir = records_root(dir).join("conflicts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for conflict in conflicts {
        let key = conflict
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or("conflict");
        let timestamp = conflict
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("0");
        let path = dir.join(format!("{timestamp}-{}.json", stable_hash(key)));
        atomic_json(&path, conflict, true)?;
    }
    Ok(())
}

pub(crate) fn conflict_count(dir: &Path) -> Result<usize, String> {
    let dir = records_root(dir).join("conflicts");
    if !dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
            count += 1;
        }
    }
    Ok(count)
}

pub(crate) fn conflict_summaries(dir: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let dir = records_root(dir).join("conflicts");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort();
    paths.reverse();

    let mut conflicts = Vec::new();
    for path in paths.into_iter().take(limit) {
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) => {
                eprintln!("could not read conflict {}: {error}", path.display());
                continue;
            }
        };
        let value: Value = match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("conflict {} is corrupt: {error}", path.display());
                continue;
            }
        };
        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        conflicts.push(conflict_summary(&id, &value));
    }
    Ok(conflicts)
}

pub(crate) fn resolve_conflict(
    dir: &Path,
    id: &str,
    use_conflict: bool,
) -> Result<Option<SyncRecord>, String> {
    let id = sanitize_conflict_id(id)?;
    let path = records_root(dir)
        .join("conflicts")
        .join(format!("{id}.json"));
    let raw = std::fs::read(&path)
        .map_err(|e| format!("could not read conflict {}: {e}", path.display()))?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("conflict {} is corrupt: {e}", path.display()))?;
    let record = if use_conflict {
        let record_value = value
            .get("conflict")
            .ok_or_else(|| "conflict record is missing".to_string())?;
        let record = parse_record(record_value)?;
        write_record(dir, &record)?;
        Some(record)
    } else {
        None
    };
    std::fs::remove_file(&path)
        .map_err(|e| format!("could not remove resolved conflict {}: {e}", path.display()))?;
    Ok(record)
}

pub(crate) fn sync_status(dir: &Path) -> Value {
    let conflicts = conflict_summaries(dir, 25).unwrap_or_default();
    json!({
        "conflictCount": conflict_count(dir).unwrap_or(0),
        "conflicts": conflicts,
    })
}

pub(crate) fn recovery_status(dir: &Path) -> Value {
    let record_problems = scan_record_problems(dir, 25);
    let conflict_problems = scan_conflict_problems(dir, 25);
    json!({
        "schemaVersion": 1,
        "skippedRecordCount": record_problems.total,
        "skippedRecords": record_problems.items,
        "corruptConflictCount": conflict_problems.total,
        "corruptConflicts": conflict_problems.items,
    })
}

pub(crate) fn payload_to_records(
    payload: &Value,
    device_id: &str,
    updated_at: u128,
) -> BTreeMap<String, SyncRecord> {
    let mut records = BTreeMap::new();
    add_vocab_records(payload, device_id, updated_at, &mut records);
    add_text_records(payload, device_id, updated_at, &mut records);
    add_pref_records(payload, device_id, updated_at, &mut records);
    add_hidden_records(payload, device_id, updated_at, &mut records);
    records
}

pub(crate) fn records_to_payload(dir: &Path, records: &BTreeMap<String, SyncRecord>) -> Value {
    records_to_payload_inner(dir, records, true, false)
}

#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) fn records_to_snapshot_payload(
    dir: &Path,
    records: &BTreeMap<String, SyncRecord>,
) -> Value {
    records_to_payload_inner(dir, records, false, false)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn records_to_mobile_snapshot_payload(
    dir: &Path,
    records: &BTreeMap<String, SyncRecord>,
) -> Value {
    records_to_payload_inner(dir, records, false, false)
}

fn records_to_payload_inner(
    dir: &Path,
    records: &BTreeMap<String, SyncRecord>,
    include_text_body: bool,
    compact_media: bool,
) -> Value {
    let mut profiles: Map<String, Value> = Map::new();
    let mut texts = Vec::new();
    let mut prefs = Map::new();
    let mut hidden = Vec::new();
    let explicit_books = explicit_book_keys(records);

    for record in records
        .values()
        .filter(|record| record.deleted_at.is_none())
    {
        match record.kind.as_str() {
            "profile" => {
                if let Some(lang) = record.key.strip_prefix("profile:") {
                    let mut profile = record.data.as_object().cloned().unwrap_or_default();
                    filter_legacy_user_books(lang, &explicit_books, &mut profile);
                    profile
                        .entry("vocab".to_string())
                        .or_insert_with(|| json!({}));
                    let existing_books = profiles
                        .get(lang)
                        .and_then(|profile| profile.get("userBooks"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    profiles.insert(lang.to_string(), Value::Object(profile));
                    for book in existing_books {
                        upsert_profile_book(&mut profiles, lang, book);
                    }
                }
            }
            "vocab" => {
                if let Some((lang, word)) = parse_lang_key(&record.key, "vocab:") {
                    let profile = profiles
                        .entry(lang.to_string())
                        .or_insert_with(|| json!({ "vocab": {} }));
                    if !profile.is_object() {
                        *profile = json!({ "vocab": {} });
                    }
                    let Some(profile_obj) = profile.as_object_mut() else {
                        continue;
                    };
                    let vocab = profile_obj
                        .entry("vocab".to_string())
                        .or_insert_with(|| json!({}));
                    if !vocab.is_object() {
                        *vocab = json!({});
                    }
                    if let Some(vocab_obj) = vocab.as_object_mut() {
                        vocab_obj.insert(word.to_string(), record.data.clone());
                    }
                }
            }
            "book" => {
                if let Some((lang, _)) = parse_lang_key(&record.key, "book:") {
                    upsert_profile_book(&mut profiles, lang, record.data.clone());
                }
            }
            "text" => {
                let mut text = record.data.clone();
                if !include_text_body {
                    if let Some(obj) = text.as_object_mut() {
                        obj.remove("text");
                        if compact_media {
                            obj.remove("pdfOcrPages");
                        }
                    }
                }
                texts.push(text);
            }
            "pref" => {
                if let Some(key) = record.key.strip_prefix("pref:") {
                    prefs.insert(key.to_string(), record.data.clone());
                }
            }
            "hidden" => {
                if let Some(id) = record.key.strip_prefix("hidden:") {
                    hidden.push(Value::String(id.to_string()));
                }
            }
            _ => {}
        }
    }

    texts.sort_by(|a, b| value_id(a).cmp(&value_id(b)));
    hidden.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    for profile in profiles.values_mut() {
        let Some(profile_obj) = profile.as_object_mut() else {
            continue;
        };
        if let Some(books) = profile_obj
            .get_mut("userBooks")
            .and_then(Value::as_array_mut)
        {
            books.sort_by(|a, b| value_id(a).cmp(&value_id(b)));
        }
    }

    json!({
        "schemaVersion": PAYLOAD_SCHEMA_VERSION,
        "dataDir": dir,
        "texts": texts,
        "prefs": prefs,
        "hiddenBooks": hidden,
        "vocab": profiles,
        "errors": [],
    })
}

pub(crate) fn revive_same_device_tombstone_backups(
    dir: &Path,
    records: &mut BTreeMap<String, SyncRecord>,
    device_id: &str,
) -> Result<bool, String> {
    let root = records_root(dir);
    if !root.exists() {
        return Ok(false);
    }
    if records
        .values()
        .any(|record| record.kind == "vocab" && record.deleted_at.is_none())
    {
        return Ok(false);
    }
    let mut revived = Vec::new();
    let dir = root.join("vocab");
    if !dir.exists() {
        return Ok(false);
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(primary) = parse_record_file(&path) else {
            continue;
        };
        if primary.deleted_at.is_none() || primary.device_id != device_id {
            continue;
        }
        let backup = path.with_extension("bak");
        if !backup.exists() {
            continue;
        }
        let Ok(backup_record) = parse_record_file(&backup) else {
            continue;
        };
        if backup_record.key == primary.key
            && backup_record.kind == "vocab"
            && backup_record.deleted_at.is_none()
        {
            revived.push(backup_record);
        }
    }
    let changed = !revived.is_empty();
    for record in revived {
        records.insert(record.key.clone(), record);
    }
    Ok(changed)
}

pub(crate) fn fingerprints(records: &BTreeMap<String, SyncRecord>) -> Fingerprints {
    records
        .iter()
        .map(|(key, record)| {
            (
                key.clone(),
                RecordFingerprint {
                    hash: fingerprint(record),
                    causal: record.causal.clone(),
                },
            )
        })
        .collect()
}

pub(crate) fn prepare_local_records(
    records: &mut BTreeMap<String, SyncRecord>,
    base: &Fingerprints,
    device_id: &str,
    now: u128,
) {
    for record in records.values_mut() {
        let base_entry = base.get(&record.key);
        if base_entry
            .map(|entry| entry.hash == fingerprint(record))
            .unwrap_or(false)
        {
            continue;
        }
        let mut causal = base_entry
            .map(|entry| entry.causal.clone())
            .unwrap_or_default();
        bump_causal(&mut causal, device_id, now);
        record.causal = causal;
    }
}

pub(crate) fn merge_records(
    base: &Fingerprints,
    incoming: BTreeMap<String, SyncRecord>,
    current: BTreeMap<String, SyncRecord>,
    device_id: &str,
    now: u128,
) -> MergeResult {
    let mut output = BTreeMap::new();
    let mut conflicts = Vec::new();
    let keys: BTreeSet<String> = base
        .keys()
        .chain(incoming.keys())
        .chain(current.keys())
        .cloned()
        .collect();

    for key in keys {
        let base_entry = base.get(&key);
        let base_hash = base_entry.map(|entry| &entry.hash);
        let base_causal = base_entry.map(|entry| &entry.causal);
        let incoming_record = incoming.get(&key);
        let current_record = current.get(&key);
        let incoming_hash = incoming_record.map(fingerprint);
        let current_hash = current_record.map(fingerprint);
        let incoming_deleted = incoming_record.is_none() && base_hash.is_some();
        let incoming_changed = incoming_deleted || incoming_hash.as_ref() != base_hash;
        let current_changed = current_hash.as_ref() != base_hash;

        let chosen = if !incoming_changed {
            current_record.cloned()
        } else if !current_changed {
            incoming_record
                .cloned()
                .or_else(|| Some(tombstone_with_base(&key, device_id, now, base_causal)))
        } else if incoming_hash.is_some() && incoming_hash == current_hash {
            current_record.cloned().or_else(|| incoming_record.cloned())
        } else if incoming_deleted
            && current_record
                .map(|record| record.deleted_at.is_some())
                .unwrap_or(false)
        {
            current_record.cloned()
        } else {
            let incoming_candidate = incoming_record
                .cloned()
                .unwrap_or_else(|| tombstone_with_base(&key, device_id, now, base_causal));
            let current_candidate = current_record
                .cloned()
                .unwrap_or_else(|| tombstone_with_base(&key, device_id, now, base_causal));
            match compare_causal(&incoming_candidate.causal, &current_candidate.causal) {
                CausalOrder::IncomingDescends => Some(incoming_candidate),
                CausalOrder::CurrentDescends => Some(current_candidate),
                CausalOrder::Concurrent | CausalOrder::Equal => {
                    let (mut keep, lose) =
                        if should_keep_incoming(&incoming_candidate, &current_candidate) {
                            (incoming_candidate, current_candidate)
                        } else {
                            (current_candidate, incoming_candidate)
                        };
                    merge_missing_text_metadata(&mut keep, &lose);
                    conflicts.push(json!({
                        "timestamp": now.to_string(),
                        "key": key,
                        "reason": "concurrent-record-changes",
                        "kept": record_value(&keep),
                        "conflict": record_value(&lose),
                    }));
                    Some(keep)
                }
            }
        };

        if let Some(record) = chosen {
            output.insert(record.key.clone(), record);
        }
    }

    MergeResult {
        records: output,
        conflicts,
    }
}

pub(crate) fn merge_missing_text_metadata(existing: &mut SyncRecord, legacy: &SyncRecord) -> bool {
    if existing.kind != "text" || legacy.kind != "text" {
        return false;
    }
    if existing.deleted_at.is_some() || legacy.deleted_at.is_some() {
        return false;
    }
    let Some(existing_obj) = existing.data.as_object_mut() else {
        return false;
    };
    let Some(legacy_obj) = legacy.data.as_object() else {
        return false;
    };
    let mut changed = false;
    for key in ["coverDataUrl", "coverPath", "coverUrl", "pdfOcrEngine"] {
        let has_value = existing_obj
            .get(key)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if has_value {
            continue;
        }
        if let Some(value) = legacy_obj
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            existing_obj.insert(key.to_string(), Value::String(value.to_string()));
            changed = true;
        }
    }
    let has_pages = existing_obj
        .get("pdfOcrPages")
        .and_then(Value::as_array)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if !has_pages {
        if let Some(value) = legacy_obj
            .get("pdfOcrPages")
            .and_then(Value::as_array)
            .filter(|value| !value.is_empty())
        {
            existing_obj.insert("pdfOcrPages".to_string(), Value::Array(value.clone()));
            changed = true;
        }
    }
    let has_page_count = existing_obj
        .get("pdfOcrPageCount")
        .and_then(Value::as_u64)
        .map(|value| value > 0)
        .unwrap_or(false);
    if !has_page_count {
        if let Some(value) = legacy_obj
            .get("pdfOcrPageCount")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        {
            existing_obj.insert("pdfOcrPageCount".to_string(), Value::from(value));
            changed = true;
        }
    }
    changed
}

pub(crate) fn text_content(dir: &Path, id: &str) -> Result<Option<String>, String> {
    let records = load_records(dir)?;
    let Some(record) = records.get(&format!("text:{id}")) else {
        return Ok(None);
    };
    if record.deleted_at.is_some() {
        return Ok(Some(String::new()));
    }
    Ok(record
        .data
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string))
}

pub(crate) fn upsert_text_record(dir: &Path, text: &Value, device_id: &str) -> Result<(), String> {
    let Some(id) = text.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let now = now_millis();
    let key = format!("text:{id}");
    let mut record = live_record(key.clone(), "text", text.clone(), device_id, now);
    if let Ok(records) = load_records(dir) {
        if let Some(existing) = records.get(&key) {
            record.causal = existing.causal.clone();
            bump_causal(&mut record.causal, device_id, now);
        }
    }
    write_record(dir, &record)
}

pub(crate) fn delete_text_record(dir: &Path, id: &str, device_id: &str) -> Result<(), String> {
    let now = now_millis();
    let key = format!("text:{id}");
    let base = load_records(dir)
        .ok()
        .and_then(|records| records.get(&key).map(|record| record.causal.clone()));
    write_record(
        dir,
        &tombstone_with_base(&key, device_id, now, base.as_ref()),
    )
}

pub(crate) fn tombstone_all(
    dir: &Path,
    device_id: &str,
) -> Result<BTreeMap<String, SyncRecord>, String> {
    let now = now_millis();
    let records = load_records(dir)?
        .keys()
        .map(|key| (key.clone(), tombstone(key, device_id, now)))
        .collect::<BTreeMap<_, _>>();
    for record in records.values() {
        write_record_with_backup(dir, record, false)?;
    }
    remove_record_backups(dir)?;
    Ok(records)
}

pub(crate) fn remove_record_backups(dir: &Path) -> Result<(), String> {
    remove_backup_files(&records_root(dir))
}

fn add_vocab_records(
    payload: &Value,
    device_id: &str,
    updated_at: u128,
    records: &mut BTreeMap<String, SyncRecord>,
) {
    let Some(vocab) = payload.get("vocab").and_then(Value::as_object) else {
        return;
    };
    let has_profiles = vocab
        .values()
        .any(|value| value.get("vocab").is_some() || value.get("preferences").is_some());
    if has_profiles {
        for (lang, profile) in vocab {
            let mut profile_obj = profile.as_object().cloned().unwrap_or_default();
            let entries = profile_obj
                .remove("vocab")
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            let user_books = profile_obj
                .remove("userBooks")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            records.insert(
                format!("profile:{lang}"),
                live_record(
                    format!("profile:{lang}"),
                    "profile",
                    Value::Object(profile_obj),
                    device_id,
                    updated_at,
                ),
            );
            for (word, entry) in entries {
                records.insert(
                    format!("vocab:{lang}:{word}"),
                    live_record(
                        format!("vocab:{lang}:{word}"),
                        "vocab",
                        entry,
                        device_id,
                        updated_at,
                    ),
                );
            }
            add_user_book_records(lang, &user_books, device_id, updated_at, records);
        }
        return;
    }

    let lang = payload
        .get("prefs")
        .and_then(|prefs| prefs.get("learningLanguage"))
        .and_then(Value::as_str)
        .unwrap_or("de");
    records.insert(
        format!("profile:{lang}"),
        live_record(
            format!("profile:{lang}"),
            "profile",
            json!({}),
            device_id,
            updated_at,
        ),
    );
    for (word, entry) in vocab {
        records.insert(
            format!("vocab:{lang}:{word}"),
            live_record(
                format!("vocab:{lang}:{word}"),
                "vocab",
                entry.clone(),
                device_id,
                updated_at,
            ),
        );
    }
    if let Some(user_books) = payload
        .get("prefs")
        .and_then(|prefs| prefs.get("__userBooks"))
        .and_then(Value::as_array)
    {
        add_user_book_records(lang, user_books, device_id, updated_at, records);
    }
}

fn add_user_book_records(
    lang: &str,
    user_books: &[Value],
    device_id: &str,
    updated_at: u128,
    records: &mut BTreeMap<String, SyncRecord>,
) {
    for book in user_books {
        if let Some(id) = book.get("id").and_then(Value::as_str) {
            records.insert(
                format!("book:{lang}:{id}"),
                live_record(
                    format!("book:{lang}:{id}"),
                    "book",
                    book.clone(),
                    device_id,
                    updated_at,
                ),
            );
        }
    }
}

fn add_text_records(
    payload: &Value,
    device_id: &str,
    updated_at: u128,
    records: &mut BTreeMap<String, SyncRecord>,
) {
    let Some(texts) = payload.get("texts").and_then(Value::as_array) else {
        return;
    };
    for text in texts {
        if let Some(id) = text.get("id").and_then(Value::as_str) {
            records.insert(
                format!("text:{id}"),
                live_record(
                    format!("text:{id}"),
                    "text",
                    text.clone(),
                    device_id,
                    updated_at,
                ),
            );
        }
    }
}

fn add_pref_records(
    payload: &Value,
    device_id: &str,
    updated_at: u128,
    records: &mut BTreeMap<String, SyncRecord>,
) {
    let Some(prefs) = payload.get("prefs").and_then(Value::as_object) else {
        return;
    };
    for (key, value) in prefs {
        records.insert(
            format!("pref:{key}"),
            live_record(
                format!("pref:{key}"),
                "pref",
                value.clone(),
                device_id,
                updated_at,
            ),
        );
    }
}

fn add_hidden_records(
    payload: &Value,
    device_id: &str,
    updated_at: u128,
    records: &mut BTreeMap<String, SyncRecord>,
) {
    let Some(hidden) = payload.get("hiddenBooks").and_then(Value::as_array) else {
        return;
    };
    for id in hidden.iter().filter_map(Value::as_str) {
        records.insert(
            format!("hidden:{id}"),
            live_record(
                format!("hidden:{id}"),
                "hidden",
                Value::String(id.to_string()),
                device_id,
                updated_at,
            ),
        );
    }
}

fn write_record(dir: &Path, record: &SyncRecord) -> Result<(), String> {
    write_record_with_backup(dir, record, true)
}

fn write_record_with_backup(
    dir: &Path,
    record: &SyncRecord,
    keep_backup: bool,
) -> Result<(), String> {
    let path = record_path(dir, record);
    if path.exists()
        && read_record_file(&path)
            .map(|existing| fingerprint(&existing) == fingerprint(record))
            .unwrap_or(false)
    {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_json(&path, &record_value(record), keep_backup)
}

fn read_record_file(path: &Path) -> Result<SyncRecord, String> {
    match parse_record_file(path) {
        Ok(record) => Ok(record),
        Err(primary) => {
            let backup = path.with_extension("bak");
            if backup.exists() {
                parse_record_file(&backup).map_err(|backup_error| {
                    format!(
                        "{primary}; backup {} is also unusable: {backup_error}",
                        backup.display()
                    )
                })
            } else {
                Err(primary)
            }
        }
    }
}

fn parse_record_file(path: &Path) -> Result<SyncRecord, String> {
    let raw = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("record {} is corrupt: {e}", path.display()))?;
    parse_record(&value).map_err(|e| format!("record {} is invalid: {e}", path.display()))
}

fn atomic_json(path: &Path, value: &Value, keep_backup: bool) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if keep_backup && path.exists() {
        std::fs::copy(path, path.with_extension("bak")).map_err(|e| e.to_string())?;
    }
    replace_with_tmp(&tmp, path)
}

fn remove_backup_files(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            remove_backup_files(&path)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("bak") {
            std::fs::remove_file(&path)
                .map_err(|e| format!("could not remove record backup {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn replace_with_tmp(tmp: &Path, path: &Path) -> Result<(), String> {
    if std::fs::rename(tmp, path).is_ok() {
        return Ok(());
    }
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("failed to replace locked record {}: {e}", path.display()))?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn record_path(dir: &Path, record: &SyncRecord) -> PathBuf {
    records_root(dir)
        .join(kind_dir(&record.kind))
        .join(format!("{}.json", stable_hash(&record.key)))
}

fn kind_dir(kind: &str) -> &str {
    match kind {
        "profile" => "profiles",
        "vocab" => "vocab",
        "text" => "texts",
        "pref" => "prefs",
        "hidden" => "hidden",
        "book" => "books",
        _ => "records",
    }
}

fn parse_record(value: &Value) -> Result<SyncRecord, String> {
    if value.get("format").and_then(Value::as_u64).unwrap_or(0) != FORMAT {
        return Err("unsupported format".to_string());
    }
    let key = value
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| "key is missing".to_string())?
        .to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "kind is missing".to_string())?
        .to_string();
    Ok(SyncRecord {
        key,
        kind,
        data: value.get("data").cloned().unwrap_or(Value::Null),
        updated_at: parse_time(value.get("updatedAt")),
        deleted_at: value.get("deletedAt").and_then(|value| {
            if value.is_null() {
                None
            } else {
                Some(parse_time(Some(value)))
            }
        }),
        device_id: value
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        causal: parse_causal(value.get("causal")),
    })
}

struct ScanProblems {
    total: usize,
    items: Vec<Value>,
}

fn scan_record_problems(dir: &Path, limit: usize) -> ScanProblems {
    let root = records_root(dir);
    let mut problems = ScanProblems {
        total: 0,
        items: Vec::new(),
    };
    if !root.exists() {
        return problems;
    }
    for kind_dir in ["profiles", "vocab", "texts", "prefs", "hidden", "books"] {
        let dir = root.join(kind_dir);
        if !dir.exists() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let extension = path.extension().and_then(|value| value.to_str());
            let record_path = match extension {
                Some("json") => path,
                Some("bak") => {
                    let primary = path.with_extension("json");
                    if primary.exists() {
                        continue;
                    }
                    primary
                }
                _ => continue,
            };
            if let Err(error) = read_record_file(&record_path) {
                problems.total += 1;
                if problems.items.len() < limit {
                    problems.items.push(json!({
                        "path": display_relative(&dir, &record_path),
                        "kind": kind_dir.trim_end_matches('s'),
                        "error": error,
                    }));
                }
            }
        }
    }
    problems
}

fn scan_conflict_problems(dir: &Path, limit: usize) -> ScanProblems {
    let dir = records_root(dir).join("conflicts");
    let mut problems = ScanProblems {
        total: 0,
        items: Vec::new(),
    };
    if !dir.exists() {
        return problems;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return problems;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        let result = std::fs::read(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))
            .and_then(|raw| {
                serde_json::from_slice::<Value>(&raw)
                    .map(|_| ())
                    .map_err(|e| format!("conflict {} is corrupt: {e}", path.display()))
            });
        if let Err(error) = result {
            problems.total += 1;
            if problems.items.len() < limit {
                problems.items.push(json!({
                    "path": display_relative(dir.parent().unwrap_or(&dir), &path),
                    "error": error,
                }));
            }
        }
    }
    problems
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

fn live_record(
    key: String,
    kind: &str,
    data: Value,
    device_id: &str,
    updated_at: u128,
) -> SyncRecord {
    SyncRecord {
        key,
        kind: kind.to_string(),
        data,
        updated_at,
        deleted_at: None,
        device_id: device_id.to_string(),
        causal: causal_from_event(device_id, updated_at),
    }
}

fn tombstone(key: &str, device_id: &str, now: u128) -> SyncRecord {
    tombstone_with_base(key, device_id, now, None)
}

fn tombstone_with_base(
    key: &str,
    device_id: &str,
    now: u128,
    base_causal: Option<&CausalClock>,
) -> SyncRecord {
    let mut causal = base_causal.cloned().unwrap_or_default();
    bump_causal(&mut causal, device_id, now);
    SyncRecord {
        key: key.to_string(),
        kind: infer_kind(key).to_string(),
        data: Value::Null,
        updated_at: now,
        deleted_at: Some(now),
        device_id: device_id.to_string(),
        causal,
    }
}

fn record_value(record: &SyncRecord) -> Value {
    json!({
        "format": FORMAT,
        "schemaVersion": PAYLOAD_SCHEMA_VERSION,
        "key": record.key,
        "kind": record.kind,
        "updatedAt": record.updated_at.to_string(),
        "deletedAt": record.deleted_at.map(|value| value.to_string()),
        "deviceId": record.device_id,
        "causal": record.causal,
        "data": record.data,
    })
}

fn fingerprint(record: &SyncRecord) -> String {
    let value = json!({
        "key": record.key,
        "kind": record.kind,
        "deleted": record.deleted_at.is_some(),
        "data": record.data,
    });
    stable_hash(&serde_json::to_string(&value).unwrap_or_default())
}

fn stable_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn parse_time(value: Option<&Value>) -> u128 {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .or_else(|| value.and_then(Value::as_u64).map(u128::from))
        .unwrap_or(0)
}

fn record_time(record: &SyncRecord) -> u128 {
    record
        .deleted_at
        .unwrap_or(record.updated_at)
        .max(record.updated_at)
}

fn should_keep_incoming(incoming: &SyncRecord, current: &SyncRecord) -> bool {
    let incoming_time = record_time(incoming);
    let current_time = record_time(current);
    if incoming_time != current_time {
        return incoming_time > current_time;
    }
    if incoming.device_id != current.device_id {
        return incoming.device_id > current.device_id;
    }
    fingerprint(incoming) >= fingerprint(current)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CausalOrder {
    IncomingDescends,
    CurrentDescends,
    Concurrent,
    Equal,
}

fn compare_causal(incoming: &CausalClock, current: &CausalClock) -> CausalOrder {
    let keys = incoming
        .keys()
        .chain(current.keys())
        .collect::<BTreeSet<_>>();
    let mut incoming_greater = false;
    let mut current_greater = false;
    for key in keys {
        let incoming_value = incoming.get(key).copied().unwrap_or(0);
        let current_value = current.get(key).copied().unwrap_or(0);
        if incoming_value > current_value {
            incoming_greater = true;
        } else if current_value > incoming_value {
            current_greater = true;
        }
    }
    match (incoming_greater, current_greater) {
        (true, false) => CausalOrder::IncomingDescends,
        (false, true) => CausalOrder::CurrentDescends,
        (true, true) => CausalOrder::Concurrent,
        (false, false) => CausalOrder::Equal,
    }
}

fn causal_from_event(device_id: &str, now: u128) -> CausalClock {
    let mut causal = CausalClock::new();
    bump_causal(&mut causal, device_id, now);
    causal
}

fn bump_causal(causal: &mut CausalClock, device_id: &str, now: u128) {
    if device_id.is_empty() {
        return;
    }
    let now = now.min(u128::from(u64::MAX)) as u64;
    let next = causal
        .get(device_id)
        .copied()
        .unwrap_or(0)
        .saturating_add(1)
        .max(now);
    causal.insert(device_id.to_string(), next);
}

fn parse_causal(value: Option<&Value>) -> CausalClock {
    let Some(object) = value.and_then(Value::as_object) else {
        return CausalClock::new();
    };
    object
        .iter()
        .filter_map(|(device, value)| {
            if device.trim().is_empty() {
                return None;
            }
            let counter = value
                .as_u64()
                .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))?;
            Some((device.to_string(), counter))
        })
        .collect()
}

fn conflict_summary(id: &str, value: &Value) -> Value {
    let kept = value.get("kept").unwrap_or(&Value::Null);
    let conflict = value.get("conflict").unwrap_or(&Value::Null);
    json!({
        "id": id,
        "timestamp": value.get("timestamp").cloned().unwrap_or(Value::Null),
        "key": value.get("key").cloned().unwrap_or(Value::Null),
        "reason": value.get("reason").cloned().unwrap_or(Value::Null),
        "kept": record_summary(kept),
        "conflict": record_summary(conflict),
    })
}

fn record_summary(value: &Value) -> Value {
    json!({
        "kind": value.get("kind").cloned().unwrap_or(Value::Null),
        "deviceId": value.get("deviceId").cloned().unwrap_or(Value::Null),
        "updatedAt": value.get("updatedAt").cloned().unwrap_or(Value::Null),
        "deleted": value.get("deletedAt").map(|value| !value.is_null()).unwrap_or(false),
    })
}

fn sanitize_conflict_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("invalid conflict id".to_string());
    }
    Ok(id.to_string())
}

fn infer_kind(key: &str) -> &str {
    key.split_once(':')
        .map(|(kind, _)| kind)
        .unwrap_or("record")
}

fn parse_lang_key<'a>(key: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    key.strip_prefix(prefix)?.split_once(':')
}

fn value_id(value: &Value) -> String {
    value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn explicit_book_keys(records: &BTreeMap<String, SyncRecord>) -> BTreeSet<String> {
    records
        .values()
        .filter(|record| record.kind == "book")
        .filter_map(|record| parse_lang_key(&record.key, "book:"))
        .map(|(lang, id)| format!("{lang}:{id}"))
        .collect()
}

fn filter_legacy_user_books(
    lang: &str,
    explicit_books: &BTreeSet<String>,
    profile: &mut Map<String, Value>,
) {
    let Some(books) = profile.get_mut("userBooks").and_then(Value::as_array_mut) else {
        return;
    };
    books.retain(|book| {
        book.get("id")
            .and_then(Value::as_str)
            .map(|id| !explicit_books.contains(&format!("{lang}:{id}")))
            .unwrap_or(true)
    });
}

fn upsert_profile_book(profiles: &mut Map<String, Value>, lang: &str, book: Value) {
    let id = value_id(&book);
    if id.is_empty() {
        return;
    }
    let profile = profiles
        .entry(lang.to_string())
        .or_insert_with(|| json!({ "vocab": {} }));
    if !profile.is_object() {
        *profile = json!({ "vocab": {} });
    }
    let Some(profile_obj) = profile.as_object_mut() else {
        return;
    };
    profile_obj
        .entry("vocab".to_string())
        .or_insert_with(|| json!({}));
    let books = profile_obj
        .entry("userBooks".to_string())
        .or_insert_with(|| json!([]));
    if !books.is_array() {
        *books = json!([]);
    }
    let Some(books) = books.as_array_mut() else {
        return;
    };
    if let Some(position) = books.iter().position(|existing| value_id(existing) == id) {
        books[position] = book;
    } else {
        books.push(book);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Value, json};

    use super::{
        SyncRecord, fingerprints, load_records, merge_records, payload_to_records, record_path,
        records_to_mobile_snapshot_payload, records_to_payload, records_to_snapshot_payload,
        recovery_status, revive_same_device_tombstone_backups, tombstone_all, write_records,
    };

    fn causal(entries: &[(&str, u64)]) -> BTreeMap<String, u64> {
        entries
            .iter()
            .map(|(device, counter)| ((*device).to_string(), *counter))
            .collect()
    }

    fn user_book_payload(user_books: Value) -> Value {
        json!({
            "texts": [],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": {
                "de": {
                    "preferences": {},
                    "userBooks": user_books,
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {}
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

    fn vocab_payload(words: &[&str]) -> Value {
        let vocab = words
            .iter()
            .map(|word| ((*word).to_string(), json!({ "status": "known" })))
            .collect::<serde_json::Map<_, _>>();
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

    #[test]
    fn write_records_skips_unchanged_files() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [],
            "prefs": { "theme": "dark" },
            "hiddenBooks": [],
            "vocab": {}
        });
        let first = payload_to_records(&payload, "device-a", 1);
        write_records(dir.path(), &first).unwrap();
        let first_record = first.values().next().unwrap();
        let path = record_path(dir.path(), first_record);
        let original = std::fs::read_to_string(&path).unwrap();

        let second = payload_to_records(&payload, "device-b", 2);
        write_records(dir.path(), &second).unwrap();

        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn load_records_skips_corrupt_record_files() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [],
            "prefs": { "theme": "dark" },
            "hiddenBooks": [],
            "vocab": {}
        });
        let records = payload_to_records(&payload, "device-a", 1);
        write_records(dir.path(), &records).unwrap();

        std::fs::create_dir_all(dir.path().join("records/v1/prefs")).unwrap();
        std::fs::write(dir.path().join("records/v1/prefs/empty.json"), "").unwrap();

        let loaded = load_records(dir.path()).unwrap();
        assert!(loaded.contains_key("pref:theme"));
    }

    #[test]
    fn recovery_status_reports_skipped_records_and_corrupt_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let records = payload_to_records(
            &json!({
                "texts": [],
                "prefs": { "theme": "dark" },
                "hiddenBooks": [],
                "vocab": {}
            }),
            "device-a",
            1,
        );
        write_records(dir.path(), &records).unwrap();
        std::fs::create_dir_all(dir.path().join("records/v1/prefs")).unwrap();
        std::fs::write(dir.path().join("records/v1/prefs/empty.json"), "").unwrap();
        std::fs::create_dir_all(dir.path().join("records/v1/conflicts")).unwrap();
        std::fs::write(dir.path().join("records/v1/conflicts/bad.json"), "{").unwrap();

        let status = recovery_status(dir.path());

        assert_eq!(status["skippedRecordCount"], 1);
        assert_eq!(status["skippedRecords"][0]["kind"], "pref");
        assert_eq!(status["skippedRecords"][0]["path"], "empty.json");
        assert!(
            status["skippedRecords"][0]["error"]
                .as_str()
                .unwrap()
                .contains("corrupt")
        );
        assert_eq!(status["corruptConflictCount"], 1);
        assert_eq!(status["corruptConflicts"][0]["path"], "conflicts/bad.json");
    }

    #[test]
    fn load_records_recovers_from_backup_when_primary_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [],
            "prefs": { "theme": "dark" },
            "hiddenBooks": [],
            "vocab": {}
        });
        let records = payload_to_records(&payload, "device-a", 1);
        write_records(dir.path(), &records).unwrap();
        let record = records.values().next().unwrap();
        let path = record_path(dir.path(), record);
        let backup = path.with_extension("bak");
        std::fs::copy(&path, &backup).unwrap();
        std::fs::remove_file(&path).unwrap();

        let loaded = load_records(dir.path()).unwrap();

        assert!(loaded.contains_key("pref:theme"));
    }

    #[test]
    fn load_records_accepts_historical_v1_record_without_schema_or_causal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("records/v1/vocab")).unwrap();
        std::fs::write(
            dir.path().join("records/v1/vocab/historical.json"),
            r#"{
              "format": 1,
              "key": "vocab:de:haus",
              "kind": "vocab",
              "updatedAt": "10",
              "deletedAt": null,
              "deviceId": "old-pc",
              "data": { "word": "haus", "translation": "house", "status": "known" }
            }"#,
        )
        .unwrap();

        let loaded = load_records(dir.path()).unwrap();
        let payload = records_to_payload(dir.path(), &loaded);

        assert!(loaded["vocab:de:haus"].causal.is_empty());
        assert_eq!(
            payload["vocab"]["de"]["vocab"]["haus"]["translation"],
            "house"
        );
        assert_eq!(recovery_status(dir.path())["skippedRecordCount"], 0);
    }

    #[test]
    fn newer_unsupported_record_format_is_reported_without_rewriting_input() {
        let dir = tempfile::tempdir().unwrap();
        let record_path = dir.path().join("records/v1/vocab/newer.json");
        std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        let newer = r#"{
          "format": 99,
          "schemaVersion": 99,
          "key": "vocab:de:haus",
          "kind": "vocab",
          "updatedAt": "10",
          "deletedAt": null,
          "deviceId": "future-device",
          "data": { "word": "haus", "translation": "future" }
        }"#;
        std::fs::write(&record_path, newer).unwrap();

        let loaded = load_records(dir.path()).unwrap();
        let status = recovery_status(dir.path());

        assert!(loaded.is_empty());
        assert_eq!(status["skippedRecordCount"], 1);
        assert!(
            status["skippedRecords"][0]["error"]
                .as_str()
                .unwrap()
                .contains("unsupported format")
        );
        assert_eq!(std::fs::read_to_string(record_path).unwrap(), newer);
    }

    #[test]
    fn snapshot_payload_keeps_text_bodies_out_of_startup_load() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [{ "id": "de-book", "title": "Buch", "text": "Sehr langer Text" }],
            "prefs": {},
            "hiddenBooks": [],
            "vocab": {}
        });
        let records = payload_to_records(&payload, "device-a", 1);

        let full = records_to_payload(dir.path(), &records);
        let snapshot = records_to_snapshot_payload(dir.path(), &records);

        assert_eq!(full["texts"][0]["text"], "Sehr langer Text");
        assert!(snapshot["texts"][0].get("text").is_none());
        assert_eq!(snapshot["texts"][0]["title"], "Buch");
    }

    #[test]
    fn mobile_snapshot_keeps_ocr_page_metadata_for_pocket_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [{
                "id": "de-book",
                "title": "Buch",
                "text": "Sehr langer Text",
                "coverDataUrl": "data:image/jpeg;base64,cover",
                "pdfOcrPages": [{ "imageName": "page-1.png", "tokens": ["big"] }]
            }],
            "prefs": {},
            "hiddenBooks": [],
            "vocab": {}
        });
        let records = payload_to_records(&payload, "device-a", 1);

        let snapshot = records_to_mobile_snapshot_payload(dir.path(), &records);

        assert!(snapshot["texts"][0].get("text").is_none());
        assert_eq!(
            snapshot["texts"][0]["coverDataUrl"],
            "data:image/jpeg;base64,cover"
        );
        assert_eq!(
            snapshot["texts"][0]["pdfOcrPages"][0]["imageName"],
            "page-1.png"
        );
        assert_eq!(snapshot["texts"][0]["title"], "Buch");
    }

    #[test]
    fn payloads_include_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let records = payload_to_records(&vocab_payload(&["haus"]), "device-a", 1);
        write_records(dir.path(), &records).unwrap();
        let payload = records_to_payload(dir.path(), &records);
        let snapshot = records_to_snapshot_payload(dir.path(), &records);
        let record = records.values().next().unwrap();
        let record_file: Value =
            serde_json::from_slice(&std::fs::read(record_path(dir.path(), record)).unwrap())
                .unwrap();

        assert_eq!(payload["schemaVersion"], 2);
        assert_eq!(snapshot["schemaVersion"], 2);
        assert_eq!(record_file["schemaVersion"], 2);
    }

    #[test]
    fn user_books_are_stored_as_individual_records() {
        let dir = tempfile::tempdir().unwrap();
        let payload = user_book_payload(json!([{
            "id": "user-1",
            "title": "Remote Book",
            "gutenbergId": "1"
        }]));

        let records = payload_to_records(&payload, "device-a", 1);
        let roundtrip = records_to_payload(dir.path(), &records);

        assert!(records.contains_key("book:de:user-1"));
        assert!(records["profile:de"].data.get("userBooks").is_none());
        assert_eq!(
            roundtrip["vocab"]["de"]["userBooks"][0]["title"],
            "Remote Book"
        );
    }

    #[test]
    fn large_vocab_payload_roundtrips_through_record_model() {
        let dir = tempfile::tempdir().unwrap();
        let mut vocab = serde_json::Map::new();
        for index in 0..10_000 {
            let word = format!("word-{index:05}");
            vocab.insert(
                word.clone(),
                json!({ "word": word, "translation": format!("translation-{index}"), "status": "learning" }),
            );
        }
        let payload = json!({
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
        });

        let records = payload_to_records(&payload, "device-a", 1);
        let roundtrip = records_to_payload(dir.path(), &records);

        assert_eq!(records.len(), 10_002);
        assert_eq!(
            roundtrip["vocab"]["de"]["vocab"]
                .as_object()
                .map(|vocab| vocab.len()),
            Some(10_000)
        );
        assert_eq!(
            roundtrip["vocab"]["de"]["vocab"]["word-09999"]["translation"],
            "translation-9999"
        );
    }

    #[test]
    fn deleted_user_book_becomes_tombstone_instead_of_returning_from_sync() {
        let dir = tempfile::tempdir().unwrap();
        let base = payload_to_records(
            &user_book_payload(json!([{ "id": "user-1", "title": "Old Book" }])),
            "pc-device",
            1,
        );
        let incoming = payload_to_records(&user_book_payload(json!([])), "phone-device", 2);

        let merged = merge_records(
            &fingerprints(&base),
            incoming,
            base.clone(),
            "phone-device",
            3,
        );
        let payload = records_to_payload(dir.path(), &merged.records);

        assert_eq!(merged.records["book:de:user-1"].kind, "book");
        assert_eq!(merged.records["book:de:user-1"].deleted_at, Some(3));
        assert_eq!(user_book_count(&payload), 0);
    }

    #[test]
    fn deleted_vocab_becomes_tombstone_instead_of_disappearing() {
        let base = payload_to_records(&vocab_payload(&["haus", "boot"]), "pc-device", 1);
        let incoming = payload_to_records(&vocab_payload(&["haus"]), "phone-device", 2);

        let merged = merge_records(
            &fingerprints(&base),
            incoming,
            base.clone(),
            "phone-device",
            3,
        );

        assert_eq!(merged.records["vocab:de:boot"].deleted_at, Some(3));
        assert!(merged.records["vocab:de:haus"].deleted_at.is_none());
    }

    #[test]
    fn book_tombstone_overrides_legacy_profile_user_books() {
        let dir = tempfile::tempdir().unwrap();
        let mut records = BTreeMap::new();
        records.insert(
            "profile:de".to_string(),
            SyncRecord {
                key: "profile:de".to_string(),
                kind: "profile".to_string(),
                data: json!({
                    "userBooks": [{ "id": "user-1", "title": "Old Book" }],
                    "vocab": {}
                }),
                updated_at: 1,
                deleted_at: None,
                device_id: "legacy-device".to_string(),
                causal: causal(&[("legacy-device", 1)]),
            },
        );
        records.insert(
            "book:de:user-1".to_string(),
            SyncRecord {
                key: "book:de:user-1".to_string(),
                kind: "book".to_string(),
                data: Value::Null,
                updated_at: 2,
                deleted_at: Some(2),
                device_id: "phone-device".to_string(),
                causal: causal(&[("phone-device", 2)]),
            },
        );

        let payload = records_to_payload(dir.path(), &records);

        assert_eq!(user_book_count(&payload), 0);
    }

    #[test]
    fn merge_keeps_media_metadata_when_newer_record_is_compact() {
        let rich = json!({
            "texts": [{
                "id": "de-book",
                "title": "Buch",
                "text": "Sehr langer Text",
                "coverDataUrl": "data:image/jpeg;base64,cover",
                "pdfOcrEngine": "paddleocr",
                "pdfOcrPageCount": 1,
                "pdfOcrPages": [{ "imageName": "page-1.png", "tokens": ["big"] }]
            }],
            "prefs": {},
            "hiddenBooks": [],
            "vocab": {}
        });
        let compact = json!({
            "texts": [{
                "id": "de-book",
                "title": "Buch",
                "text": "Sehr langer Text"
            }],
            "prefs": {},
            "hiddenBooks": [],
            "vocab": {}
        });
        let rich_records = payload_to_records(&rich, "pc-device", 1);
        let compact_records = payload_to_records(&compact, "android-device", 2);

        let merged = merge_records(
            &BTreeMap::new(),
            rich_records,
            compact_records,
            "pc-device",
            3,
        );
        let record = &merged.records["text:de-book"];

        assert_eq!(record.device_id, "android-device");
        assert_eq!(record.data["coverDataUrl"], "data:image/jpeg;base64,cover");
        assert_eq!(record.data["pdfOcrEngine"], "paddleocr");
        assert_eq!(record.data["pdfOcrPageCount"], 1);
        assert_eq!(record.data["pdfOcrPages"][0]["imageName"], "page-1.png");
    }

    #[test]
    fn causal_descendant_wins_over_skewed_newer_wall_clock() {
        let base_record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "base" }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let current = SyncRecord {
            data: json!({ "word": "haus", "translation": "current" }),
            updated_at: 5000,
            causal: causal(&[("pc-device", 2)]),
            ..base_record.clone()
        };
        let incoming = SyncRecord {
            data: json!({ "word": "haus", "translation": "incoming" }),
            updated_at: 100,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 2), ("phone-device", 3)]),
            ..base_record.clone()
        };
        let base = [(base_record.key.clone(), base_record)]
            .into_iter()
            .collect();
        let incoming_records = [(incoming.key.clone(), incoming)].into_iter().collect();
        let current_records = [(current.key.clone(), current)].into_iter().collect();

        let merged = merge_records(
            &fingerprints(&base),
            incoming_records,
            current_records,
            "phone-device",
            6000,
        );

        assert_eq!(
            merged.records["vocab:de:haus"].data["translation"],
            "incoming"
        );
        assert!(merged.conflicts.is_empty());
    }

    #[test]
    fn concurrent_causal_clocks_preserve_conflict_even_when_one_timestamp_is_newer() {
        let base_record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "base" }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let incoming = SyncRecord {
            data: json!({ "word": "haus", "translation": "phone" }),
            updated_at: 100,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: json!({ "word": "haus", "translation": "laptop" }),
            updated_at: 5000,
            device_id: "laptop-device".to_string(),
            causal: causal(&[("pc-device", 1), ("laptop-device", 2)]),
            ..base_record.clone()
        };
        let base = [(base_record.key.clone(), base_record)]
            .into_iter()
            .collect();
        let incoming_records = [(incoming.key.clone(), incoming)].into_iter().collect();
        let current_records = [(current.key.clone(), current)].into_iter().collect();

        let merged = merge_records(
            &fingerprints(&base),
            incoming_records,
            current_records,
            "phone-device",
            6000,
        );

        assert_eq!(
            merged.records["vocab:de:haus"].data["translation"],
            "laptop"
        );
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.conflicts[0]["reason"], "concurrent-record-changes");
    }

    #[test]
    fn concurrent_delete_update_is_preserved_as_conflict() {
        let base_record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "base" }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let current = SyncRecord {
            data: json!({ "word": "haus", "translation": "laptop" }),
            updated_at: 5000,
            device_id: "laptop-device".to_string(),
            causal: causal(&[("pc-device", 1), ("laptop-device", 2)]),
            ..base_record.clone()
        };
        let base = [(base_record.key.clone(), base_record)]
            .into_iter()
            .collect();
        let current_records = [(current.key.clone(), current)].into_iter().collect();

        let merged = merge_records(
            &fingerprints(&base),
            BTreeMap::new(),
            current_records,
            "phone-device",
            6000,
        );

        assert!(merged.records["vocab:de:haus"].deleted_at.is_some());
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.conflicts[0]["reason"], "concurrent-record-changes");
    }

    #[test]
    fn legacy_records_without_causal_clock_still_fall_back_deterministically() {
        let base = BTreeMap::new();
        let incoming = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "incoming" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "z-device".to_string(),
            causal: BTreeMap::new(),
        };
        let current = SyncRecord {
            key: incoming.key.clone(),
            kind: incoming.kind.clone(),
            data: json!({ "word": "haus", "translation": "current" }),
            updated_at: 9,
            deleted_at: None,
            device_id: "a-device".to_string(),
            causal: BTreeMap::new(),
        };
        let incoming_records = [(incoming.key.clone(), incoming)].into_iter().collect();
        let current_records = [(current.key.clone(), current)].into_iter().collect();

        let merged = merge_records(&base, incoming_records, current_records, "z-device", 11);

        assert_eq!(
            merged.records["vocab:de:haus"].data["translation"],
            "incoming"
        );
        assert_eq!(merged.conflicts.len(), 1);
    }

    #[test]
    fn equal_timestamp_conflicts_use_deterministic_device_tiebreaker() {
        let base = BTreeMap::new();
        let incoming = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "incoming" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "z-device".to_string(),
            causal: causal(&[("z-device", 10)]),
        };
        let current = SyncRecord {
            key: incoming.key.clone(),
            kind: incoming.kind.clone(),
            data: json!({ "word": "haus", "translation": "current" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "a-device".to_string(),
            causal: causal(&[("a-device", 10)]),
        };
        let incoming_records = [(incoming.key.clone(), incoming)].into_iter().collect();
        let current_records = [(current.key.clone(), current)].into_iter().collect();

        let merged = merge_records(&base, incoming_records, current_records, "z-device", 11);

        assert_eq!(
            merged.records["vocab:de:haus"].data["translation"],
            "incoming"
        );
        assert_eq!(merged.conflicts.len(), 1);
    }

    #[test]
    fn equal_timestamp_conflicts_are_order_independent() {
        let base = BTreeMap::new();
        let z_record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "z" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "z-device".to_string(),
            causal: causal(&[("z-device", 10)]),
        };
        let a_record = SyncRecord {
            key: z_record.key.clone(),
            kind: z_record.kind.clone(),
            data: json!({ "word": "haus", "translation": "a" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "a-device".to_string(),
            causal: causal(&[("a-device", 10)]),
        };
        let first = merge_records(
            &base,
            [(z_record.key.clone(), z_record.clone())]
                .into_iter()
                .collect(),
            [(a_record.key.clone(), a_record.clone())]
                .into_iter()
                .collect(),
            "z-device",
            11,
        );
        let second = merge_records(
            &base,
            [(a_record.key.clone(), a_record)].into_iter().collect(),
            [(z_record.key.clone(), z_record)].into_iter().collect(),
            "a-device",
            11,
        );

        assert_eq!(first.records["vocab:de:haus"].data["translation"], "z");
        assert_eq!(second.records["vocab:de:haus"].data["translation"], "z");
        assert_eq!(first.conflicts.len(), 1);
        assert_eq!(second.conflicts.len(), 1);
    }

    #[test]
    fn equal_timestamp_delete_update_conflicts_are_deterministic() {
        let base = BTreeMap::new();
        let tombstone = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: Value::Null,
            updated_at: 10,
            deleted_at: Some(10),
            device_id: "z-device".to_string(),
            causal: causal(&[("z-device", 10)]),
        };
        let update = SyncRecord {
            key: tombstone.key.clone(),
            kind: tombstone.kind.clone(),
            data: json!({ "word": "haus", "translation": "alive" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "a-device".to_string(),
            causal: causal(&[("a-device", 10)]),
        };
        let first = merge_records(
            &base,
            [(tombstone.key.clone(), tombstone.clone())]
                .into_iter()
                .collect(),
            [(update.key.clone(), update.clone())].into_iter().collect(),
            "z-device",
            11,
        );
        let second = merge_records(
            &base,
            [(update.key.clone(), update)].into_iter().collect(),
            [(tombstone.key.clone(), tombstone)].into_iter().collect(),
            "a-device",
            11,
        );

        assert_eq!(first.records["vocab:de:haus"].deleted_at, Some(10));
        assert_eq!(second.records["vocab:de:haus"].deleted_at, Some(10));
        assert_eq!(first.conflicts.len(), 1);
        assert_eq!(second.conflicts.len(), 1);
    }

    #[test]
    fn revives_same_device_tombstone_from_live_backup() {
        let dir = tempfile::tempdir().unwrap();
        let live = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 1,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 1)]),
        };
        let deleted = SyncRecord {
            data: Value::Null,
            updated_at: 2,
            deleted_at: Some(2),
            ..live.clone()
        };
        let live_records = [(live.key.clone(), live)].into_iter().collect();
        write_records(dir.path(), &live_records).unwrap();
        let deleted_records = [(deleted.key.clone(), deleted)].into_iter().collect();
        write_records(dir.path(), &deleted_records).unwrap();
        let mut loaded = load_records(dir.path()).unwrap();

        let changed =
            revive_same_device_tombstone_backups(dir.path(), &mut loaded, "device-a").unwrap();

        assert!(changed);
        assert!(loaded["vocab:de:haus"].deleted_at.is_none());
        assert_eq!(loaded["vocab:de:haus"].data["translation"], "house");
    }

    #[test]
    fn does_not_revive_deleted_vocab_when_other_live_vocab_exists() {
        let dir = tempfile::tempdir().unwrap();
        let live = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 1,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 1)]),
        };
        let deleted = SyncRecord {
            data: Value::Null,
            updated_at: 2,
            deleted_at: Some(2),
            ..live.clone()
        };
        let other_live = SyncRecord {
            key: "vocab:de:boot".to_string(),
            data: json!({ "word": "boot", "translation": "boat" }),
            ..live.clone()
        };
        let first_records = [(live.key.clone(), live)].into_iter().collect();
        write_records(dir.path(), &first_records).unwrap();
        let second_records = [
            (deleted.key.clone(), deleted),
            (other_live.key.clone(), other_live),
        ]
        .into_iter()
        .collect();
        write_records(dir.path(), &second_records).unwrap();
        let mut loaded = load_records(dir.path()).unwrap();

        let changed =
            revive_same_device_tombstone_backups(dir.path(), &mut loaded, "device-a").unwrap();

        assert!(!changed);
        assert!(loaded["vocab:de:haus"].deleted_at.is_some());
        assert!(loaded["vocab:de:boot"].deleted_at.is_none());
    }

    #[test]
    fn tombstone_all_removes_record_backups_so_wipe_cannot_revive_vocab() {
        let dir = tempfile::tempdir().unwrap();
        let live = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 1,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 1)]),
        };
        let updated = SyncRecord {
            data: json!({ "word": "haus", "translation": "home" }),
            updated_at: 2,
            ..live.clone()
        };
        let record_path = record_path(dir.path(), &live);
        let first_records = [(live.key.clone(), live)].into_iter().collect();
        write_records(dir.path(), &first_records).unwrap();
        let second_records = [(updated.key.clone(), updated)].into_iter().collect();
        write_records(dir.path(), &second_records).unwrap();
        assert!(record_path.with_extension("bak").exists());

        tombstone_all(dir.path(), "device-a").unwrap();
        let mut loaded = load_records(dir.path()).unwrap();
        let changed =
            revive_same_device_tombstone_backups(dir.path(), &mut loaded, "device-a").unwrap();

        assert!(!changed);
        assert!(loaded["vocab:de:haus"].deleted_at.is_some());
        assert!(!record_path.with_extension("bak").exists());
    }
}
