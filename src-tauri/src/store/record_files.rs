use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::durable;
use crate::tokenizer;

const FORMAT: u64 = 1;
const PAYLOAD_SCHEMA_VERSION: u64 = 2;
const ROOT: &str = "records";
const VERSION: &str = "v1";
const RECORD_DIRS: [&str; 6] = ["profiles", "vocab", "texts", "prefs", "hidden", "books"];
const IN_TEXT_REVIEW_COMPLETIONS_KEY: &str = "pref:inTextReviewCompletedGuesses";
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecordFingerprint {
    pub hash: String,
    pub causal: CausalClock,
    pub data: Option<Value>,
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

#[cfg(not(target_os = "android"))]
pub(crate) fn has_records(dir: &Path) -> bool {
    let root = records_root(dir);
    RECORD_DIRS.iter().any(|name| root.join(name).is_dir())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn validate_records_layout(dir: &Path) -> Result<(), String> {
    let records = dir.join(ROOT);
    ensure_optional_dir(&records)?;
    if !records.exists() {
        return Ok(());
    }

    let root = records.join(VERSION);
    ensure_optional_dir(&root)?;
    if !root.exists() {
        return Ok(());
    }

    for name in RECORD_DIRS {
        ensure_optional_dir(&root.join(name))?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn ensure_optional_dir(path: &Path) -> Result<(), String> {
    if path.exists() && !path.is_dir() {
        return Err(format!(
            "configured data folder has a file where WordHunter needs a folder: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn load_records(dir: &Path) -> Result<BTreeMap<String, SyncRecord>, String> {
    let root = records_root(dir);
    let mut records = BTreeMap::new();
    if !root.exists() {
        return Ok(records);
    }
    for kind_dir in RECORD_DIRS {
        let dir = root.join(kind_dir);
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.contains(".sync-conflict-"))
            {
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str());
            let is_record = matches!(extension, Some("yaml" | "yml" | "json"));
            let is_backup = path.extension().and_then(|value| value.to_str()) == Some("bak");
            let path = if is_record {
                if extension == Some("json") && path.with_extension("yaml").exists() {
                    continue;
                }
                path
            } else if is_backup {
                let yaml = path.with_extension("yaml");
                let primary = if yaml.exists() {
                    yaml
                } else {
                    path.with_extension("json")
                };
                if primary.exists() {
                    continue;
                }
                path
            } else {
                continue;
            };
            match read_record_file(&path) {
                Ok(record) => {
                    records.insert(record.key.clone(), record);
                }
                Err(error) => {
                    // Skip one bad record instead of killing startup; recovery status reports it.
                    eprintln!("{error}");
                }
            }
        }
    }
    Ok(canonicalize_vocab_records(records))
}

pub(crate) fn migrate_legacy_json_records(dir: &Path) -> Result<usize, String> {
    let records = load_records(dir)?;
    let mut migrated = 0;
    for record in records.values() {
        let yaml = record_path(dir, record);
        let json = yaml.with_extension("json");
        if !json.exists() {
            continue;
        }
        write_record_with_backup(dir, record, true)?;
        read_record_file(&yaml)?;
        durable::remove_file_if_exists(&json)?;
        durable::remove_file_if_exists(&json.with_extension("bak"))?;
        migrated += 1;
    }
    Ok(migrated)
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

pub(crate) fn recovery_status(dir: &Path) -> Value {
    let record_problems = scan_record_problems(dir, 25);
    json!({
        "schemaVersion": 1,
        "skippedRecordCount": record_problems.total,
        "skippedRecords": record_problems.items,
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

#[cfg(test)]
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
    records_to_payload_inner(dir, records, false, true)
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

    for record in records
        .values()
        .filter(|record| record.deleted_at.is_none())
    {
        match record.kind.as_str() {
            "profile" => {
                if let Some(lang) = record.key.strip_prefix("profile:") {
                    let mut profile = record.data.as_object().cloned().unwrap_or_default();
                    profile.remove("userBooks");
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
                let mut text = if !include_text_body && compact_media {
                    match record.data.as_object() {
                        Some(data) => {
                            let mut compact: Map<String, Value> = data
                                .iter()
                                .filter(|(key, _)| !matches!(key.as_str(), "text" | "pdfOcrPages"))
                                .map(|(key, value)| (key.clone(), value.clone()))
                                .collect();
                            let page_count = data
                                .get("pdfOcrPages")
                                .and_then(Value::as_array)
                                .map(Vec::len)
                                .unwrap_or(0);
                            if page_count > 0 {
                                compact
                                    .insert("pdfOcrPageCount".to_string(), Value::from(page_count));
                            }
                            Value::Object(compact)
                        }
                        None => record.data.clone(),
                    }
                } else {
                    record.data.clone()
                };
                if !include_text_body
                    && !compact_media
                    && let Some(obj) = text.as_object_mut()
                {
                    obj.remove("text");
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

    texts.sort_by_key(value_id);
    hidden.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    for profile in profiles.values_mut() {
        let Some(profile_obj) = profile.as_object_mut() else {
            continue;
        };
        if let Some(books) = profile_obj
            .get_mut("userBooks")
            .and_then(Value::as_array_mut)
        {
            books.sort_by_key(value_id);
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

pub(crate) fn fingerprints(records: &BTreeMap<String, SyncRecord>) -> Fingerprints {
    records
        .iter()
        .map(|(key, record)| {
            (
                key.clone(),
                RecordFingerprint {
                    hash: fingerprint(record),
                    causal: record.causal.clone(),
                    data: (record.key == "pref:readerBookmarks"
                        || (record.kind == "vocab" && is_vocab_alias_retirement(&record.data)))
                    .then(|| record.data.clone()),
                },
            )
        })
        .collect()
}

pub(crate) fn prepare_local_records(
    records: &mut BTreeMap<String, SyncRecord>,
    base: &Fingerprints,
    current: &BTreeMap<String, SyncRecord>,
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
            .or_else(|| {
                current
                    .get(&record.key)
                    .filter(|current| current.deleted_at.is_some())
                    .map(|current| current.causal.clone())
            })
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
    full_keys: &BTreeSet<String>,
) -> MergeResult {
    let incoming = canonicalize_vocab_records(incoming);
    let current = canonicalize_vocab_records(current);
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
        if key == IN_TEXT_REVIEW_COMPLETIONS_KEY {
            if let (Some(incoming), Some(current)) = (incoming_record, current_record)
                && let Some(merged) = merge_in_text_review_completions(incoming, current)
            {
                output.insert(key, merged);
                continue;
            }
            // Older frontend snapshots omit this preference. Omission must not erase progress.
            let sole_record = match (incoming_record, current_record) {
                (Some(record), None) | (None, Some(record)) => Some(record),
                _ => None,
            };
            if let Some(record) = sole_record
                && record.deleted_at.is_none()
                && record.data.as_u64().is_some()
            {
                output.insert(key, record.clone());
                continue;
            }
        }
        let incoming_hash = incoming_record.map(fingerprint);
        let current_hash = current_record.map(fingerprint);
        let omitted_alias_retirement = incoming_record.is_none()
            && base_entry
                .and_then(|entry| entry.data.as_ref())
                .is_some_and(is_vocab_alias_retirement);
        // Incremental saves: a key declared in fullKeys but not sent is
        // untouched by the frontend — treat it as unchanged (hash == base).
        let omitted_untouched = incoming_record.is_none() && full_keys.contains(&key);
        let incoming_hash = if omitted_untouched {
            base_hash.cloned()
        } else {
            incoming_hash
        };
        let incoming_deleted = incoming_record.is_none()
            && base_hash.is_some()
            && !omitted_alias_retirement
            && !full_keys.contains(&key);
        let incoming_changed =
            !omitted_alias_retirement && (incoming_deleted || incoming_hash.as_ref() != base_hash);
        let current_changed = current_hash.as_ref() != base_hash;

        let chosen = if !incoming_changed {
            current_record.cloned()
        } else if !current_changed {
            match (incoming_record, current_record) {
                (Some(incoming), Some(current))
                    if incoming.deleted_at.is_none()
                        && current.deleted_at.is_some()
                        && compare_causal(&incoming.causal, &current.causal)
                            != CausalOrder::IncomingDescends =>
                {
                    Some(current.clone())
                }
                _ => incoming_record
                    .cloned()
                    .or_else(|| Some(tombstone_with_base(&key, device_id, now, base_causal))),
            }
        } else if incoming_hash.is_some() && incoming_hash == current_hash {
            match (incoming_record, current_record) {
                (Some(incoming), Some(current)) => Some(merge_equal_records(incoming, current)),
                _ => current_record.cloned().or_else(|| incoming_record.cloned()),
            }
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
                CausalOrder::IncomingDescends => {
                    let mut keep = incoming_candidate;
                    merge_vocab_status(&mut keep, &current_candidate);
                    merge_vocab_schedule(&mut keep, &current_candidate);
                    Some(keep)
                }
                CausalOrder::CurrentDescends => {
                    let mut keep = current_candidate;
                    merge_vocab_status(&mut keep, &incoming_candidate);
                    merge_vocab_schedule(&mut keep, &incoming_candidate);
                    Some(keep)
                }
                CausalOrder::Concurrent | CausalOrder::Equal => {
                    let (mut keep, lose) =
                        if should_keep_incoming(&incoming_candidate, &current_candidate) {
                            (incoming_candidate, current_candidate)
                        } else {
                            (current_candidate, incoming_candidate)
                        };
                    merge_missing_text_media_metadata(&mut keep, &lose);
                    let original_keep = keep.clone();
                    let mut conflict_choice = lose.clone();
                    let bookmark_merge_handled = match base_entry {
                        None => merge_reader_bookmark_data(&mut keep, &lose, None, false),
                        Some(base) => base
                            .data
                            .as_ref()
                            .map(|data| {
                                merge_reader_bookmark_data(&mut keep, &lose, Some(data), false)
                            })
                            .unwrap_or(false),
                    };
                    let vocab_status_merge_handled = merge_vocab_status(&mut keep, &lose);
                    let vocab_schedule_merge_handled = merge_vocab_schedule(&mut keep, &lose);
                    if vocab_status_merge_handled || vocab_schedule_merge_handled {
                        let _ = merge_vocab_status(&mut conflict_choice, &original_keep);
                        let _ = merge_vocab_schedule(&mut conflict_choice, &original_keep);
                    }
                    if bookmark_merge_handled
                        || vocab_status_merge_handled
                        || vocab_schedule_merge_handled
                    {
                        let base_data = base_entry.and_then(|base| base.data.as_ref());
                        if bookmark_merge_handled {
                            let _ = merge_reader_bookmark_data(
                                &mut conflict_choice,
                                &original_keep,
                                base_data,
                                true,
                            );
                        }
                        for (device, counter) in lose.causal.iter() {
                            keep.causal
                                .entry(device.clone())
                                .and_modify(|value| *value = (*value).max(*counter))
                                .or_insert(*counter);
                        }
                        bump_causal(&mut keep.causal, device_id, now);
                        keep.updated_at = now;
                        keep.device_id = device_id.to_string();
                    }
                    conflicts.push(json!({
                        "timestamp": now.to_string(),
                        "key": key,
                        "reason": "concurrent-record-changes",
                        "kept": record_value(&keep),
                        "conflict": record_value(&conflict_choice),
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
        records: canonicalize_vocab_records(output),
        conflicts,
    }
}

fn merge_in_text_review_completions(
    incoming: &SyncRecord,
    current: &SyncRecord,
) -> Option<SyncRecord> {
    if incoming.key != IN_TEXT_REVIEW_COMPLETIONS_KEY
        || current.key != IN_TEXT_REVIEW_COMPLETIONS_KEY
        || incoming.deleted_at.is_some()
        || current.deleted_at.is_some()
    {
        return None;
    }
    let count = incoming.data.as_u64()?.max(current.data.as_u64()?);
    let mut merged = match compare_causal(&incoming.causal, &current.causal) {
        CausalOrder::IncomingDescends => incoming.clone(),
        CausalOrder::CurrentDescends => current.clone(),
        CausalOrder::Concurrent | CausalOrder::Equal => {
            if should_keep_incoming(incoming, current) {
                incoming.clone()
            } else {
                current.clone()
            }
        }
    };
    merged.data = Value::from(count);
    merge_causal_clock(&mut merged.causal, &incoming.causal);
    merge_causal_clock(&mut merged.causal, &current.causal);
    Some(merged)
}

fn merge_vocab_status(existing: &mut SyncRecord, source: &SyncRecord) -> bool {
    if existing.kind != "vocab"
        || source.kind != "vocab"
        || existing.deleted_at.is_some()
        || source.deleted_at.is_some()
    {
        return false;
    }
    let Some(existing_status) = existing.data.get("status").and_then(Value::as_str) else {
        return false;
    };
    let Some(source_status) = source.data.get("status").and_then(Value::as_str) else {
        return false;
    };
    let Some(existing_rank) = vocab_status_rank(existing_status) else {
        return false;
    };
    let Some(source_rank) = vocab_status_rank(source_status) else {
        return false;
    };
    let existing_time = vocab_status_changed_at(&existing.data, existing_status);
    let source_time = vocab_status_changed_at(&source.data, source_status);
    if existing_status == source_status && existing_time == source_time {
        return false;
    }

    let source_wins = match (existing_time, source_time) {
        (Some(existing_time), Some(source_time)) if existing_time != source_time => {
            source_time > existing_time
        }
        (Some(_), None) => false,
        (None, Some(_)) => true,
        _ => source_rank > existing_rank,
    };
    if source_wins {
        copy_vocab_status_bundle(&mut existing.data, &source.data);
    }
    true
}

fn merge_vocab_schedule(existing: &mut SyncRecord, source: &SyncRecord) -> bool {
    if existing.kind != "vocab"
        || source.kind != "vocab"
        || existing.deleted_at.is_some()
        || source.deleted_at.is_some()
    {
        return false;
    }
    let existing_time = vocab_data_time(&existing.data, &["lastReviewedAt"]);
    let source_time = vocab_data_time(&source.data, &["lastReviewedAt"]);
    let source_wins = match (existing_time, source_time) {
        (Some(existing_time), Some(source_time)) if existing_time != source_time => {
            source_time > existing_time
        }
        (Some(_), None) => false,
        (None, Some(_)) => true,
        _ if has_vocab_schedule(&existing.data) != has_vocab_schedule(&source.data) => {
            has_vocab_schedule(&source.data)
        }
        _ => should_keep_incoming(source, existing),
    };
    let differs = VOCAB_SCHEDULE_FIELDS
        .iter()
        .any(|field| existing.data.get(*field) != source.data.get(*field));
    if source_wins {
        let Some(target) = existing.data.as_object_mut() else {
            return false;
        };
        copy_vocab_bundle(target, &source.data, VOCAB_SCHEDULE_FIELDS);
    }
    differs
}

const VOCAB_STATUS_FIELDS: &[&str] = &["status", "statusUpdatedAt", "knownAt", "learningStartedAt"];
const VOCAB_SCHEDULE_FIELDS: &[&str] = &[
    "repetition",
    "interval",
    "efactor",
    "stability",
    "difficulty",
    "nextDate",
    "lastReviewedAt",
    "srsAlgorithm",
];

fn vocab_data_time(data: &Value, fields: &[&str]) -> Option<OffsetDateTime> {
    fields
        .iter()
        .filter_map(|field| data.get(*field).and_then(Value::as_str))
        .find_map(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
}

fn prefer_vocab_data<'a>(first: &'a Value, second: &'a Value) -> (&'a Value, &'a Value) {
    let first_time = vocab_data_time(first, &["updatedAt", "addedAt"]);
    let second_time = vocab_data_time(second, &["updatedAt", "addedAt"]);
    let second_wins = match (first_time, second_time) {
        (Some(first), Some(second)) if first != second => second > first,
        (Some(_), None) => false,
        (None, Some(_)) => true,
        _ => {
            serde_json::to_string(second).unwrap_or_default()
                > serde_json::to_string(first).unwrap_or_default()
        }
    };
    if second_wins {
        (second, first)
    } else {
        (first, second)
    }
}

fn prefer_vocab_status_data<'a>(first: &'a Value, second: &'a Value) -> &'a Value {
    let first_status = first.get("status").and_then(Value::as_str);
    let second_status = second.get("status").and_then(Value::as_str);
    let first_rank = first_status.and_then(vocab_status_rank);
    let second_rank = second_status.and_then(vocab_status_rank);
    if first_rank.is_some() != second_rank.is_some() {
        return if second_rank.is_some() { second } else { first };
    }
    let first_time = first_status.and_then(|status| vocab_status_changed_at(first, status));
    let second_time = second_status.and_then(|status| vocab_status_changed_at(second, status));
    match (first_time, second_time) {
        (Some(first_time), Some(second_time)) if first_time != second_time => {
            if second_time > first_time {
                second
            } else {
                first
            }
        }
        (Some(_), None) => first,
        (None, Some(_)) => second,
        _ if first_rank != second_rank => {
            if second_rank > first_rank {
                second
            } else {
                first
            }
        }
        _ => prefer_vocab_data(first, second).0,
    }
}

fn has_vocab_schedule(data: &Value) -> bool {
    VOCAB_SCHEDULE_FIELDS
        .iter()
        .any(|field| data.get(*field).is_some())
}

fn prefer_vocab_schedule_data<'a>(first: &'a Value, second: &'a Value) -> &'a Value {
    let first_time = vocab_data_time(first, &["lastReviewedAt"]);
    let second_time = vocab_data_time(second, &["lastReviewedAt"]);
    match (first_time, second_time) {
        (Some(first_time), Some(second_time)) if first_time != second_time => {
            if second_time > first_time {
                second
            } else {
                first
            }
        }
        (Some(_), None) => first,
        (None, Some(_)) => second,
        _ if has_vocab_schedule(first) != has_vocab_schedule(second) => {
            if has_vocab_schedule(second) {
                second
            } else {
                first
            }
        }
        _ => prefer_vocab_data(first, second).0,
    }
}

fn copy_vocab_bundle(target: &mut Map<String, Value>, source: &Value, fields: &[&str]) {
    for field in fields {
        match source.get(*field) {
            Some(value) => {
                target.insert((*field).to_string(), value.clone());
            }
            None => {
                target.remove(*field);
            }
        }
    }
}

fn nonempty_vocab_field(data: &Value, field: &str) -> bool {
    data.get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn merge_vocab_entry_data(existing: &mut Value, source: &Value) -> bool {
    let (preferred, fallback) = prefer_vocab_data(existing, source);
    let (Some(preferred_obj), Some(fallback_obj)) = (preferred.as_object(), fallback.as_object())
    else {
        return false;
    };
    let mut merged = fallback_obj.clone();
    merged.extend(preferred_obj.clone());
    copy_vocab_bundle(
        &mut merged,
        prefer_vocab_status_data(existing, source),
        VOCAB_STATUS_FIELDS,
    );
    copy_vocab_bundle(
        &mut merged,
        prefer_vocab_schedule_data(existing, source),
        VOCAB_SCHEDULE_FIELDS,
    );
    for field in ["word", "article", "note", "imageUrl"] {
        if !nonempty_vocab_field(&Value::Object(merged.clone()), field)
            && nonempty_vocab_field(fallback, field)
            && let Some(value) = fallback.get(field)
        {
            merged.insert(field.to_string(), value.clone());
        }
    }
    let translation_source = if nonempty_vocab_field(preferred, "translation")
        || preferred
            .get("translationAutoRejected")
            .and_then(Value::as_bool)
            == Some(true)
    {
        preferred
    } else {
        fallback
    };
    copy_vocab_bundle(
        &mut merged,
        translation_source,
        &[
            "translation",
            "translationSource",
            "translationAutoRejected",
        ],
    );
    let mut examples = Vec::new();
    for value in [preferred, fallback]
        .into_iter()
        .filter_map(|data| data.get("examples").and_then(Value::as_array))
        .flatten()
    {
        if !examples.contains(value) && examples.len() < 3 {
            examples.push(value.clone());
        }
    }
    merged.insert("examples".to_string(), Value::Array(examples));
    let added_at = [(&*existing, true), (source, false)]
        .into_iter()
        .filter_map(|(data, is_existing)| {
            let value = data.get("addedAt").and_then(Value::as_str)?;
            let parsed = OffsetDateTime::parse(value, &Rfc3339).ok()?;
            Some((parsed, value.to_string(), is_existing))
        })
        .min_by_key(|(parsed, _, _)| *parsed)
        .map(|(_, value, _)| value)
        .or_else(|| {
            [&*existing, source]
                .into_iter()
                .filter_map(|data| data.get("addedAt").and_then(Value::as_str))
                .min()
                .map(|v| v.to_string())
        });
    match added_at {
        Some(value) => {
            merged.insert("addedAt".to_string(), Value::String(value));
        }
        None => {
            merged.remove("addedAt");
        }
    };
    let updated_at = [(&*existing, true), (source, false)]
        .into_iter()
        .filter_map(|(data, is_existing)| {
            let value = data.get("updatedAt").and_then(Value::as_str)?;
            let parsed = OffsetDateTime::parse(value, &Rfc3339).ok()?;
            Some((parsed, value.to_string(), is_existing))
        })
        .max_by_key(|(parsed, _, _)| *parsed)
        .map(|(_, value, _)| value)
        .or_else(|| {
            [&*existing, source]
                .into_iter()
                .filter_map(|data| data.get("updatedAt").and_then(Value::as_str))
                .max()
                .map(|v| v.to_string())
        });
    match updated_at {
        Some(value) => {
            merged.insert("updatedAt".to_string(), Value::String(value));
        }
        None => {
            merged.remove("updatedAt");
        }
    };
    let next = Value::Object(merged);
    let changed = *existing != next;
    *existing = next;
    changed
}

const VOCAB_ALIAS_MARKER: &str = "_wordHunterCanonicalAlias";

fn is_vocab_alias_retirement(data: &Value) -> bool {
    data.get(VOCAB_ALIAS_MARKER)
        .and_then(Value::as_str)
        .is_some()
}

fn merge_causal_clock(target: &mut CausalClock, source: &CausalClock) {
    for (device, counter) in source {
        target
            .entry(device.clone())
            .and_modify(|value| *value = (*value).max(*counter))
            .or_insert(*counter);
    }
}

fn profile_vocabulary_language(records: &BTreeMap<String, SyncRecord>, lang: &str) -> String {
    if lang != "other" {
        return lang.to_string();
    }
    records
        .get(&format!("profile:{lang}"))
        .and_then(|record| record.data.get("preferences"))
        .and_then(|value| value.get("translationSourceLanguage"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(lang)
        .to_string()
}

fn canonical_vocab_record_key(
    record: &SyncRecord,
    records: &BTreeMap<String, SyncRecord>,
) -> Option<String> {
    let (lang, key_word) = parse_lang_key(&record.key, "vocab:")?;
    if let Some(canonical) = record.data.get(VOCAB_ALIAS_MARKER).and_then(Value::as_str) {
        return Some(canonical.to_string());
    }
    let identity_word = record
        .data
        .get("word")
        .and_then(Value::as_str)
        .unwrap_or(key_word);
    let language = profile_vocabulary_language(records, lang);
    let word = tokenizer::vocabulary_word_key(identity_word, &language);
    (!word.is_empty()).then(|| format!("vocab:{lang}:{word}"))
}

fn canonicalize_vocab_records(
    records: BTreeMap<String, SyncRecord>,
) -> BTreeMap<String, SyncRecord> {
    let mut output = records
        .iter()
        .filter(|(_, record)| record.kind != "vocab")
        .map(|(key, record)| (key.clone(), record.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut groups: BTreeMap<String, Vec<SyncRecord>> = BTreeMap::new();
    for record in records.values().filter(|record| record.kind == "vocab") {
        let canonical =
            canonical_vocab_record_key(record, &records).unwrap_or_else(|| record.key.clone());
        groups.entry(canonical).or_default().push(record.clone());
    }

    for (canonical_key, group) in groups {
        let mut group_causal = CausalClock::new();
        let mut live_only_causal = CausalClock::new();
        for record in &group {
            merge_causal_clock(&mut group_causal, &record.causal);
            if record.deleted_at.is_none() && !is_vocab_alias_retirement(&record.data) {
                merge_causal_clock(&mut live_only_causal, &record.causal);
            }
        }
        let real_tombstones = group
            .iter()
            .filter(|record| {
                record.deleted_at.is_some() && !is_vocab_alias_retirement(&record.data)
            })
            .filter(|tombstone| {
                tombstone.key == canonical_key
                    || group.iter().any(|live| {
                        live.deleted_at.is_none()
                            && !is_vocab_alias_retirement(&live.data)
                            && compare_causal(&tombstone.causal, &live.causal)
                                == CausalOrder::IncomingDescends
                    })
            })
            .collect::<Vec<_>>();
        let winning_tombstone = real_tombstones.first();
        let canonical_record = if let Some(first) = winning_tombstone {
            let preferred =
                real_tombstones
                    .iter()
                    .skip(1)
                    .fold((*first).clone(), |keep, source| {
                        if should_keep_incoming(source, &keep) {
                            (*source).clone()
                        } else {
                            keep
                        }
                    });
            SyncRecord {
                key: canonical_key.clone(),
                kind: "vocab".to_string(),
                data: Value::Null,
                updated_at: group
                    .iter()
                    .map(record_time)
                    .max()
                    .unwrap_or(preferred.updated_at),
                deleted_at: Some(
                    group
                        .iter()
                        .map(record_time)
                        .max()
                        .unwrap_or(preferred.updated_at),
                ),
                device_id: preferred.device_id,
                causal: group_causal.clone(),
            }
        } else {
            let mut live = group.iter().filter(|record| {
                record.deleted_at.is_none() && !is_vocab_alias_retirement(&record.data)
            });
            let Some(first) = live.next() else {
                for record in group {
                    output.insert(record.key.clone(), record);
                }
                continue;
            };
            let mut preferred = first.clone();
            for source in live {
                let source_is_preferred = should_keep_incoming(source, &preferred);
                merge_vocab_entry_data(&mut preferred.data, &source.data);
                if source_is_preferred {
                    preferred.updated_at = source.updated_at;
                    preferred.device_id = source.device_id.clone();
                }
            }
            preferred.key = canonical_key.clone();
            preferred.causal = live_only_causal.clone();
            preferred
        };
        output.insert(canonical_key.clone(), canonical_record.clone());

        for alias_key in group
            .iter()
            .map(|record| record.key.as_str())
            .filter(|key| *key != canonical_key)
            .collect::<BTreeSet<_>>()
        {
            let deleted_at = group
                .iter()
                .map(record_time)
                .max()
                .unwrap_or(canonical_record.updated_at);
            output.insert(
                alias_key.to_string(),
                SyncRecord {
                    key: alias_key.to_string(),
                    kind: "vocab".to_string(),
                    data: if canonical_record.deleted_at.is_some() {
                        Value::Null
                    } else {
                        Value::Object(Map::from_iter([(
                            VOCAB_ALIAS_MARKER.to_string(),
                            Value::String(canonical_key.clone()),
                        )]))
                    },
                    updated_at: deleted_at,
                    deleted_at: Some(deleted_at),
                    device_id: canonical_record.device_id.clone(),
                    causal: canonical_record.causal.clone(),
                },
            );
        }
    }
    output
}

fn vocab_status_rank(status: &str) -> Option<u8> {
    match status {
        "new" => Some(0),
        "learning" => Some(1),
        "ignored" => Some(2),
        "known" => Some(3),
        _ => None,
    }
}

fn vocab_status_changed_at(data: &Value, status: &str) -> Option<OffsetDateTime> {
    let status_specific = match status {
        "known" => data.get("knownAt"),
        "learning" => data.get("learningStartedAt"),
        _ => None,
    };
    [data.get("statusUpdatedAt"), status_specific]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
}

fn copy_vocab_status_bundle(target: &mut Value, source: &Value) {
    let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) else {
        return;
    };
    for key in ["status", "statusUpdatedAt", "knownAt", "learningStartedAt"] {
        match source.get(key) {
            Some(value) => {
                target.insert(key.to_string(), value.clone());
            }
            None => {
                target.remove(key);
            }
        }
    }
}

pub(crate) fn merge_missing_text_media_metadata(
    existing: &mut SyncRecord,
    source: &SyncRecord,
) -> bool {
    if existing.kind != "text" || source.kind != "text" {
        return false;
    }
    if existing.deleted_at.is_some() || source.deleted_at.is_some() {
        return false;
    }
    let Some(existing_obj) = existing.data.as_object_mut() else {
        return false;
    };
    let Some(source_obj) = source.data.as_object() else {
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
        if let Some(value) = source_obj
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
    if !has_pages
        && let Some(value) = source_obj
            .get("pdfOcrPages")
            .and_then(Value::as_array)
            .filter(|value| !value.is_empty())
    {
        existing_obj.insert("pdfOcrPages".to_string(), Value::Array(value.clone()));
        changed = true;
    }
    let has_page_count = existing_obj
        .get("pdfOcrPageCount")
        .and_then(Value::as_u64)
        .map(|value| value > 0)
        .unwrap_or(false);
    if !has_page_count
        && let Some(value) = source_obj
            .get("pdfOcrPageCount")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
    {
        existing_obj.insert("pdfOcrPageCount".to_string(), Value::from(value));
        changed = true;
    }
    changed
}

fn text_record(dir: &Path, id: &str) -> Result<Option<SyncRecord>, String> {
    let key = format!("text:{id}");
    let yaml = records_root(dir)
        .join(kind_dir("text"))
        .join(format!("{}.yaml", stable_hash(&key)));
    let path = if yaml.exists() || yaml.with_extension("bak").exists() {
        yaml
    } else {
        yaml.with_extension("json")
    };
    if !path.exists() && !path.with_extension("bak").exists() {
        return Ok(None);
    }
    let record = match read_record_file(&path) {
        Ok(record) if record.key == key => record,
        Ok(_) => return Ok(None),
        Err(error) => {
            eprintln!("{error}");
            return Ok(None);
        }
    };
    if record.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub(crate) fn text_content(dir: &Path, id: &str) -> Result<Option<String>, String> {
    Ok(text_record(dir, id)?.as_ref().and_then(|record| {
        record
            .data
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    }))
}

pub(crate) fn text_pdf_ocr_pages(dir: &Path, id: &str) -> Result<Option<Value>, String> {
    Ok(text_record(dir, id)?
        .as_ref()
        .and_then(|record| record.data.get("pdfOcrPages").cloned()))
}

pub(crate) fn upsert_text_record(dir: &Path, text: &Value, device_id: &str) -> Result<(), String> {
    let Some(id) = text.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let now = now_millis();
    let key = format!("text:{id}");
    let mut record = live_record(key.clone(), "text", text.clone(), device_id, now);
    // Read only the one existing record for its causal clock instead of
    // scanning the whole records tree (which is seconds on large stores).
    if let Ok(Some(existing)) = read_existing_record(dir, "text", &key) {
        record.causal = existing.causal.clone();
        bump_causal(&mut record.causal, device_id, now);
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
        .iter()
        .map(|(key, record)| {
            (
                key.clone(),
                tombstone_with_base(key, device_id, now, Some(&record.causal)),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for record in records.values() {
        write_record_with_backup(dir, record, false)?;
    }
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
    if !has_profiles {
        return;
    }

    for (lang, profile) in vocab {
        let mut profile_obj = profile.as_object().cloned().unwrap_or_default();
        let vocabulary_lang = if lang == "other" {
            profile_obj
                .get("preferences")
                .and_then(|value| value.get("translationSourceLanguage"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(lang)
        } else {
            lang
        }
        .to_string();
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
        for (word, mut entry) in entries {
            let identity_word = entry.get("word").and_then(Value::as_str).unwrap_or(&word);
            let key = tokenizer::vocabulary_word_key(identity_word, &vocabulary_lang);
            if key.is_empty() {
                continue;
            }
            if let Some(entry) = entry.as_object_mut() {
                entry
                    .entry("word".to_string())
                    .or_insert_with(|| Value::String(word.clone()));
            }
            let record_key = format!("vocab:{lang}:{key}");
            let record = live_record(record_key.clone(), "vocab", entry, device_id, updated_at);
            if let Some(existing) = records.get_mut(&record_key) {
                merge_vocab_entry_data(&mut existing.data, &record.data);
            } else {
                records.insert(record_key, record);
            }
        }
        add_user_book_records(lang, &user_books, device_id, updated_at, records);
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
    reject_future_record_at_path(&path)?;
    if record.deleted_at.is_some() {
        let value = record_value(record);
        if path.exists()
            && parse_record_file(&path)
                .map(|existing| records_equal(&existing, record))
                .unwrap_or(false)
        {
            return write_record_recovery_backup(&path);
        }
        atomic_yaml(&path, &value, false)?;
        return write_record_recovery_backup(&path);
    }
    if path.exists()
        && read_record_file(&path)
            .map(|existing| records_equal(&existing, record))
            .unwrap_or(false)
    {
        return Ok(());
    }
    atomic_yaml(&path, &record_value(record), keep_backup)
}

fn write_record_recovery_backup(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("bak");
    let temp = path.with_extension("bak.tmp");
    durable::remove_file_if_exists(&temp)?;
    std::fs::copy(path, &temp).map_err(|e| {
        format!(
            "could not stage record recovery backup {} from {}: {e}",
            temp.display(),
            path.display()
        )
    })?;
    durable::sync_file(&temp)?;
    if let Err(first_error) = std::fs::rename(&temp, &backup) {
        if !backup.exists() {
            return Err(format!(
                "could not install record recovery backup {}: {first_error}",
                backup.display()
            ));
        }
        durable::remove_file_if_exists(&backup)?;
        std::fs::rename(&temp, &backup).map_err(|e| {
            format!(
                "could not replace record recovery backup {} after {first_error}: {e}",
                backup.display()
            )
        })?;
    }
    durable::sync_parent(&backup)
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
    let value: Value = serde_yaml::from_slice(&raw)
        .map_err(|e| format!("record {} is corrupt: {e}", path.display()))?;
    let record =
        parse_record(&value).map_err(|e| format!("record {} is invalid: {e}", path.display()))?;
    let expected_dir = kind_dir(&record.kind);
    let actual_dir = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if actual_dir != expected_dir {
        return Err(format!(
            "record {} is in {actual_dir}, expected {expected_dir}",
            path.display()
        ));
    }
    let expected_name = stable_hash(&record.key);
    let actual_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if actual_name != expected_name {
        return Err(format!(
            "record {} has a noncanonical filename",
            path.display()
        ));
    }
    Ok(record)
}

fn atomic_yaml(path: &Path, value: &Value, keep_backup: bool) -> Result<(), String> {
    let bytes = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    durable::write_file_atomic(path, bytes.as_bytes(), keep_backup)
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
            durable::remove_file_if_exists(&path)
                .map_err(|e| format!("could not remove record backup {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

pub(crate) fn record_path(dir: &Path, record: &SyncRecord) -> PathBuf {
    records_root(dir)
        .join(kind_dir(&record.kind))
        .join(format!("{}.yaml", stable_hash(&record.key)))
}

/// Read one record by key without scanning the whole records tree.
/// Mirrors `load_records`'s file preference (yaml > yml > json; a .bak
/// stands in only when no primary exists) and its tolerance of corrupt
/// files (a broken record yields `None`, matching the skip-and-continue
/// behaviour of the full scan).
pub(crate) fn read_existing_record(
    dir: &Path,
    kind: &str,
    key: &str,
) -> Result<Option<SyncRecord>, String> {
    let root = records_root(dir).join(kind_dir(kind));
    let base = root.join(stable_hash(key));
    let mut primary: Option<PathBuf> = None;
    for extension in ["yaml", "yml", "json"] {
        let candidate = base.with_extension(extension);
        if candidate.exists() {
            primary = Some(candidate);
            break;
        }
    }
    let path = match primary {
        Some(path) => path,
        None => {
            let backup = base.with_extension("bak");
            if backup.exists() {
                backup
            } else {
                return Ok(None);
            }
        }
    };
    match read_record_file(&path) {
        Ok(record) => Ok(Some(record)),
        Err(error) => {
            eprintln!("{error}");
            Ok(None)
        }
    }
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

pub(crate) fn parse_record(value: &Value) -> Result<SyncRecord, String> {
    if value.get("format").and_then(Value::as_u64).unwrap_or(0) != FORMAT {
        return Err("unsupported format".to_string());
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "schemaVersion is missing".to_string())?;
    if schema_version != PAYLOAD_SCHEMA_VERSION {
        return Err("unsupported schemaVersion".to_string());
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
    if !RECORD_DIRS.contains(&kind_dir(&kind)) || infer_kind(&key) != kind {
        return Err("key and kind do not match a supported record type".to_string());
    }
    if key
        .split_once(':')
        .map(|(_, suffix)| suffix.trim().is_empty())
        .unwrap_or(true)
    {
        return Err("record key suffix is empty".to_string());
    }
    let updated_at = parse_required_time(value.get("updatedAt"), "updatedAt")?;
    let deleted_at = match value.get("deletedAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_required_time(Some(value), "deletedAt")?),
    };
    let device_id = value
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|device| !device.trim().is_empty())
        .ok_or_else(|| "deviceId is missing".to_string())?
        .to_string();
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let mut causal = parse_causal(value.get("causal"))?;
    if causal.is_empty() {
        causal = legacy_causal_clock(&key, &kind, &data, updated_at, deleted_at, &device_id);
    }
    Ok(SyncRecord {
        key,
        kind,
        data,
        updated_at,
        deleted_at,
        device_id,
        causal,
    })
}

fn reject_future_record_at_path(path: &Path) -> Result<(), String> {
    for candidate in [path.to_path_buf(), path.with_extension("bak")] {
        if !candidate.exists() {
            continue;
        }
        let raw = std::fs::read(&candidate).map_err(|e| {
            format!(
                "could not inspect record before replacing {}: {e}",
                candidate.display()
            )
        })?;
        let Ok(value) = serde_yaml::from_slice::<Value>(&raw) else {
            continue;
        };
        let future_format = value
            .get("format")
            .and_then(Value::as_u64)
            .map(|format| format > FORMAT)
            .unwrap_or(false);
        let future_schema = value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map(|schema| schema > PAYLOAD_SCHEMA_VERSION)
            .unwrap_or(false);
        if future_format || future_schema {
            return Err(format!(
                "refusing to overwrite newer unsupported record {}",
                candidate.display()
            ));
        }
    }
    Ok(())
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
    for kind_dir in RECORD_DIRS {
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
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.contains(".sync-conflict-"))
            {
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str());
            let record_path = match extension {
                Some("yaml" | "yml" | "json") => path,
                Some("bak") => {
                    let yaml = path.with_extension("yaml");
                    let primary = if yaml.exists() {
                        yaml
                    } else {
                        path.with_extension("json")
                    };
                    if primary.exists() {
                        continue;
                    }
                    path
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

fn bookmark_identity(value: &Value) -> Option<String> {
    let id = value_id(value);
    if id.is_empty() {
        serde_json::to_string(value).ok()
    } else {
        Some(id)
    }
}

fn bookmark_values(value: Option<&Value>) -> Option<BTreeMap<String, Value>> {
    let Some(value) = value else {
        return Some(BTreeMap::new());
    };
    value
        .as_array()?
        .iter()
        .map(|bookmark| Some((bookmark_identity(bookmark)?, bookmark.clone())))
        .collect()
}

fn merge_reader_bookmark_data(
    existing: &mut SyncRecord,
    source: &SyncRecord,
    base: Option<&Value>,
    preserve_concurrent_edits: bool,
) -> bool {
    if existing.key != "pref:readerBookmarks"
        || source.key != "pref:readerBookmarks"
        || existing.deleted_at.is_some()
        || source.deleted_at.is_some()
    {
        return false;
    }
    let Some(existing_books) = existing.data.as_object() else {
        return false;
    };
    let Some(source_books) = source.data.as_object() else {
        return false;
    };
    let base_books = match base {
        Some(value) => {
            let Some(books) = value.as_object() else {
                return false;
            };
            Some(books)
        }
        None => None,
    };
    let book_ids = existing_books
        .keys()
        .chain(source_books.keys())
        .chain(base_books.into_iter().flat_map(|books| books.keys()))
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut merged_books = Map::new();
    for book_id in book_ids {
        let Some(base_bookmarks) =
            bookmark_values(base_books.and_then(|books| books.get(&book_id)))
        else {
            return false;
        };
        let Some(existing_bookmarks) = bookmark_values(existing_books.get(&book_id)) else {
            return false;
        };
        let Some(source_bookmarks) = bookmark_values(source_books.get(&book_id)) else {
            return false;
        };
        let mut merged = Vec::new();
        let mut merged_ids = BTreeSet::new();
        for (identity, bookmark) in &existing_bookmarks {
            if base_bookmarks.contains_key(identity) && !source_bookmarks.contains_key(identity) {
                let changed_from_base = base_bookmarks.get(identity) != Some(bookmark);
                if !preserve_concurrent_edits || !changed_from_base {
                    continue;
                }
            }
            let selected = match (base_bookmarks.get(identity), source_bookmarks.get(identity)) {
                (Some(base), Some(source)) if bookmark == base && source != base => source,
                _ => bookmark,
            };
            merged_ids.insert(identity.clone());
            merged.push(selected.clone());
        }
        for (identity, bookmark) in &source_bookmarks {
            let deleted_by_existing =
                base_bookmarks.contains_key(identity) && !existing_bookmarks.contains_key(identity);
            let changed_from_base = base_bookmarks.get(identity) != Some(bookmark);
            if merged_ids.contains(identity)
                || (deleted_by_existing && (!preserve_concurrent_edits || !changed_from_base))
            {
                continue;
            }
            merged_ids.insert(identity.clone());
            merged.push(bookmark.clone());
        }
        if !merged.is_empty() {
            merged_books.insert(book_id, Value::Array(merged));
        }
    }
    existing.data = Value::Object(merged_books);
    true
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
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

pub(crate) fn record_value(record: &SyncRecord) -> Value {
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

fn records_equal(left: &SyncRecord, right: &SyncRecord) -> bool {
    left.key == right.key
        && left.kind == right.kind
        && left.data == right.data
        && left.updated_at == right.updated_at
        && left.deleted_at == right.deleted_at
        && left.device_id == right.device_id
        && left.causal == right.causal
}

fn merge_equal_records(incoming: &SyncRecord, current: &SyncRecord) -> SyncRecord {
    let mut merged = if should_keep_incoming(incoming, current) {
        incoming.clone()
    } else {
        current.clone()
    };
    for (device, counter) in incoming.causal.iter().chain(current.causal.iter()) {
        merged
            .causal
            .entry(device.clone())
            .and_modify(|value| *value = (*value).max(*counter))
            .or_insert(*counter);
    }
    merged.updated_at = incoming.updated_at.max(current.updated_at);
    if incoming.deleted_at.is_some() {
        merged.deleted_at = incoming.deleted_at.max(current.deleted_at);
    }
    merged
}

/// True when the record's content differs from the in-memory base snapshot.
/// Used by the delta save path to write only the records that actually
/// changed, instead of re-opening every record file on disk.
pub(crate) fn record_changed_since_base(record: &SyncRecord, base: &Fingerprints) -> bool {
    base.get(&record.key)
        .map(|entry| entry.hash != fingerprint(record))
        .unwrap_or(true)
}

pub(crate) fn stable_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn legacy_causal_clock(
    key: &str,
    kind: &str,
    data: &Value,
    updated_at: u128,
    deleted_at: Option<u128>,
    device_id: &str,
) -> CausalClock {
    let identity = json!({
        "key": key,
        "kind": kind,
        "data": data,
        "updatedAt": updated_at.to_string(),
        "deletedAt": deleted_at.map(|value| value.to_string()),
        "deviceId": device_id,
    });
    let digest = Sha256::digest(serde_json::to_vec(&identity).unwrap_or_default());
    let component = digest
        .iter()
        .fold(String::from("wordhunter-legacy-"), |mut output, byte| {
            use std::fmt::Write;
            let _ = write!(output, "{byte:02x}");
            output
        });
    BTreeMap::from([(component, 1)])
}

fn parse_required_time(value: Option<&Value>, field: &str) -> Result<u128, String> {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .or_else(|| value.and_then(Value::as_u64).map(u128::from))
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{field} is invalid"))
}

pub(crate) fn record_time(record: &SyncRecord) -> u128 {
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

fn parse_causal(value: Option<&Value>) -> Result<CausalClock, String> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Err("causal is missing".to_string());
    };
    let mut causal = CausalClock::new();
    for (device, value) in object {
        if device.trim().is_empty() {
            return Err("causal contains an empty device id".to_string());
        }
        let counter = value
            .as_u64()
            .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
            .ok_or_else(|| format!("causal counter for {device} is invalid"))?;
        causal.insert(device.to_string(), counter);
    }
    Ok(causal)
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
    use std::collections::{BTreeMap, BTreeSet};

    use serde_json::{Value, json};

    use super::{
        FORMAT, PAYLOAD_SCHEMA_VERSION, SyncRecord, canonicalize_vocab_records, fingerprints,
        live_record, load_records, merge_records, merge_vocab_entry_data, merge_vocab_schedule,
        merge_vocab_status, parse_record, parse_record_file, payload_to_records,
        prepare_local_records, read_record_file, record_path, records_to_mobile_snapshot_payload,
        records_to_payload, records_to_snapshot_payload, recovery_status, tombstone_all, value_id,
        write_record, write_records,
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
    fn vocab_record_keys_are_case_insensitive_and_keep_display_spelling() {
        let records = payload_to_records(&vocab_payload(&["Am", "AM", "am"]), "device-a", 1);
        let vocab_records = records
            .values()
            .filter(|record| record.kind == "vocab")
            .collect::<Vec<_>>();

        assert_eq!(vocab_records.len(), 1);
        assert_eq!(vocab_records[0].key, "vocab:de:am");
        assert!(vocab_records[0].data["word"].as_str().is_some());
    }

    #[test]
    fn merge_vocab_entry_data_picks_added_at_by_parsed_instant_not_lexicographic() {
        let mut existing = json!({
            "addedAt": "2026-07-25T10:00:00+02:00",
            "updatedAt": "2026-07-25T08:00:00Z"
        });
        let source = json!({
            "addedAt": "2026-07-25T06:00:00-05:00",
            "updatedAt": "2026-07-25T14:00:00+02:00"
        });

        merge_vocab_entry_data(&mut existing, &source);

        assert_eq!(existing["addedAt"], "2026-07-25T10:00:00+02:00");
        assert_eq!(existing["updatedAt"], "2026-07-25T14:00:00+02:00");
    }

    #[test]
    fn payload_case_collisions_merge_status_schedule_and_metadata_bundles() {
        let payload = json!({
            "texts": [],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": {
                "de": {
                    "preferences": {},
                    "vocab": {
                        "AM": {
                            "word": "AM",
                            "status": "learning",
                            "statusUpdatedAt": "2026-01-01T00:00:00Z",
                            "translation": "new metadata",
                            "repetition": 9,
                            "interval": 30,
                            "lastReviewedAt": "2026-03-01T00:00:00Z",
                            "updatedAt": "2026-04-01T00:00:00Z"
                        },
                        "Am": {
                            "word": "Am",
                            "status": "known",
                            "statusUpdatedAt": "2026-02-01T00:00:00Z",
                            "translation": "old metadata",
                            "repetition": 3,
                            "interval": 6,
                            "lastReviewedAt": "2026-02-01T00:00:00Z",
                            "updatedAt": "2026-02-01T00:00:00Z"
                        }
                    }
                }
            }
        });

        let records = payload_to_records(&payload, "device-a", 1);
        let entry = &records["vocab:de:am"].data;
        assert_eq!(entry["word"], "AM");
        assert_eq!(entry["status"], "known");
        assert_eq!(entry["statusUpdatedAt"], "2026-02-01T00:00:00Z");
        assert_eq!(entry["translation"], "new metadata");
        assert_eq!(entry["repetition"], 9);
        assert_eq!(entry["interval"], 30);
        assert_eq!(entry["lastReviewedAt"], "2026-03-01T00:00:00Z");
    }

    #[test]
    fn other_profile_rekeys_from_display_word_using_configured_source_locale() {
        let payload = json!({
            "texts": [],
            "prefs": { "learningLanguage": "other" },
            "hiddenBooks": [],
            "vocab": {
                "other": {
                    "preferences": { "translationSourceLanguage": "tr_TR" },
                    "vocab": { "i": { "word": "I", "status": "known" } }
                }
            }
        });

        let records = payload_to_records(&payload, "device-a", 1);
        assert!(records.contains_key("vocab:other:ı"));
        assert!(!records.contains_key("vocab:other:i"));
    }

    #[test]
    fn stale_case_alias_cannot_resurrect_after_two_device_delete() {
        let stale_alias = SyncRecord {
            key: "vocab:de:Am".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "Am", "status": "known", "translation": "at the" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 10)]),
        };
        let device_a = canonicalize_vocab_records(
            [(stale_alias.key.clone(), stale_alias.clone())]
                .into_iter()
                .collect(),
        );
        assert!(device_a["vocab:de:am"].deleted_at.is_none());
        assert!(device_a["vocab:de:Am"].deleted_at.is_some());

        let deleted = merge_records(
            &fingerprints(&device_a),
            BTreeMap::new(),
            device_a,
            "device-b",
            20,
            &BTreeSet::new(),
        );
        assert!(deleted.records["vocab:de:am"].deleted_at.is_some());

        let converged = merge_records(
            &BTreeMap::new(),
            [(stale_alias.key.clone(), stale_alias)]
                .into_iter()
                .collect(),
            deleted.records,
            "device-a",
            30,
            &BTreeSet::new(),
        );
        for key in ["vocab:de:am", "vocab:de:Am"] {
            assert!(converged.records[key].deleted_at.is_some(), "{key}");
            assert_eq!(
                converged.records[key].causal.get("device-a"),
                Some(&10),
                "{key}"
            );
            assert!(converged.records[key].causal.get("device-b") >= Some(&20));
        }
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

        write_records(dir.path(), &first).unwrap();

        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn write_records_persists_changed_causal_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [],
            "prefs": { "theme": "dark" },
            "hiddenBooks": [],
            "vocab": {}
        });
        let first = payload_to_records(&payload, "device-a", 1);
        write_records(dir.path(), &first).unwrap();
        let path = record_path(dir.path(), first.values().next().unwrap());
        let original = std::fs::read_to_string(&path).unwrap();

        let second = payload_to_records(&payload, "device-b", 2);
        write_records(dir.path(), &second).unwrap();

        assert_ne!(std::fs::read_to_string(&path).unwrap(), original);
        let stored = read_record_file(&path).unwrap();
        assert_eq!(stored.device_id, "device-b");
        assert_eq!(stored.causal.get("device-b"), Some(&2));
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
    fn malformed_deleted_at_uses_valid_record_backup() {
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
        let path = record_path(dir.path(), records.values().next().unwrap());
        std::fs::copy(&path, path.with_extension("bak")).unwrap();
        let mut malformed: Value = serde_yaml::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        malformed["deletedAt"] = Value::String("not-a-time".to_string());
        std::fs::write(&path, serde_yaml::to_string(&malformed).unwrap()).unwrap();

        let loaded = load_records(dir.path()).unwrap();

        assert!(loaded["pref:theme"].deleted_at.is_none());
        assert_eq!(loaded["pref:theme"].data, "dark");
    }

    #[test]
    fn record_parser_rejects_semantically_invalid_identity_fields() {
        let valid = json!({
            "format": FORMAT,
            "schemaVersion": PAYLOAD_SCHEMA_VERSION,
            "key": "pref:theme",
            "kind": "pref",
            "updatedAt": "1",
            "deletedAt": null,
            "deviceId": "device-a",
            "causal": { "device-a": 1 },
            "data": "dark"
        });
        let mut wrong_kind = valid.clone();
        wrong_kind["kind"] = Value::String("text".to_string());
        assert!(parse_record(&wrong_kind).is_err());

        let mut missing_device = valid.clone();
        missing_device["deviceId"] = Value::String(String::new());
        assert!(parse_record(&missing_device).is_err());

        let mut invalid_time = valid;
        invalid_time["updatedAt"] = Value::String("invalid".to_string());
        assert!(parse_record(&invalid_time).is_err());
    }

    #[test]
    fn record_parser_restores_deterministic_clocks_for_legacy_empty_clocks() {
        let legacy = json!({
            "format": FORMAT,
            "schemaVersion": PAYLOAD_SCHEMA_VERSION,
            "key": "vocab:de:haus",
            "kind": "vocab",
            "updatedAt": "10",
            "deletedAt": null,
            "deviceId": "legacy-device",
            "causal": {},
            "data": { "word": "haus", "translation": "house", "status": "known" }
        });

        let first = parse_record(&legacy).unwrap();
        let second = parse_record(&legacy).unwrap();
        assert_eq!(first.causal, second.causal);
        assert_eq!(first.causal.len(), 1);
        assert!(
            first
                .causal
                .keys()
                .next()
                .unwrap()
                .starts_with("wordhunter-legacy-")
        );

        let mut divergent = legacy.clone();
        divergent["data"]["translation"] = Value::String("home".to_string());
        let divergent = parse_record(&divergent).unwrap();
        assert_ne!(first.causal, divergent.causal);
        assert_eq!(
            super::compare_causal(&first.causal, &divergent.causal),
            super::CausalOrder::Concurrent
        );

        let dir = tempfile::tempdir().unwrap();
        let path = record_path(dir.path(), &first);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(&path, &original).unwrap();
        let loaded = load_records(dir.path()).unwrap();
        assert_eq!(loaded["vocab:de:haus"].causal, first.causal);
        assert_eq!(recovery_status(dir.path())["skippedRecordCount"], 0);
        write_records(dir.path(), &loaded).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), original);

        let mut tombstone = legacy;
        tombstone["deletedAt"] = Value::String("11".to_string());
        let tombstone = parse_record(&tombstone).unwrap();
        assert_eq!(tombstone.deleted_at, Some(11));
        assert_ne!(tombstone.causal, first.causal);
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
    fn in_text_review_completion_records_merge_with_max_and_ignore_snapshot_omission() {
        let lower = live_record(
            "pref:inTextReviewCompletedGuesses".to_string(),
            "pref",
            json!(1),
            "desktop",
            10,
        );
        let higher = live_record(
            "pref:inTextReviewCompletedGuesses".to_string(),
            "pref",
            json!(3),
            "pocket",
            11,
        );
        let merged = merge_records(
            &BTreeMap::new(),
            BTreeMap::from([(lower.key.clone(), lower)]),
            BTreeMap::from([(higher.key.clone(), higher.clone())]),
            "desktop",
            12,
            &BTreeSet::new(),
        );

        assert_eq!(
            merged.records["pref:inTextReviewCompletedGuesses"].data,
            json!(3)
        );
        assert!(merged.conflicts.is_empty());

        let omitted = merge_records(
            &fingerprints(&BTreeMap::from([(higher.key.clone(), higher.clone())])),
            BTreeMap::new(),
            BTreeMap::from([(higher.key.clone(), higher)]),
            "legacy-device",
            13,
            &BTreeSet::new(),
        );
        assert_eq!(
            omitted.records["pref:inTextReviewCompletedGuesses"].data,
            json!(3)
        );
        assert!(
            omitted.records["pref:inTextReviewCompletedGuesses"]
                .deleted_at
                .is_none()
        );
    }

    #[test]
    fn load_records_reports_malformed_record_without_schema_or_causal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("records/v1/vocab")).unwrap();
        std::fs::write(
            dir.path().join("records/v1/vocab/malformed.json"),
            r#"{
              "format": 1,
              "key": "vocab:de:haus",
              "kind": "vocab",
              "updatedAt": "10",
              "deletedAt": null,
              "deviceId": "broken-device",
              "data": { "word": "haus", "translation": "house", "status": "known" }
            }"#,
        )
        .unwrap();

        let loaded = load_records(dir.path()).unwrap();

        assert!(!loaded.contains_key("vocab:de:haus"));
        assert_eq!(recovery_status(dir.path())["skippedRecordCount"], 1);
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
    fn newer_unsupported_record_schema_is_reported_without_rewriting_input() {
        let dir = tempfile::tempdir().unwrap();
        let record_path = dir.path().join("records/v1/vocab/newer-schema.json");
        std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        let newer = r#"{
          "format": 1,
          "schemaVersion": 99,
          "key": "vocab:de:haus",
          "kind": "vocab",
          "updatedAt": "10",
          "deletedAt": null,
          "deviceId": "future-device",
          "causal": { "future-device": 10 },
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
                .contains("unsupported schemaVersion")
        );
        assert_eq!(std::fs::read_to_string(record_path).unwrap(), newer);
    }

    #[test]
    fn newer_unsupported_record_at_canonical_path_is_not_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let mut records = payload_to_records(&vocab_payload(&["haus"]), "device-a", 1);
        let record = records.remove("vocab:de:haus").unwrap();
        let path = record_path(dir.path(), &record);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let newer = r#"{
          "format": 1,
          "schemaVersion": 99,
          "key": "vocab:de:haus",
          "kind": "vocab",
          "updatedAt": "10",
          "deletedAt": null,
          "deviceId": "future-device",
          "causal": { "future-device": 10 },
          "data": { "word": "haus", "translation": "future" }
        }"#;
        std::fs::write(&path, newer).unwrap();
        let replacement = [(record.key.clone(), record)].into_iter().collect();

        let error = write_records(dir.path(), &replacement).unwrap_err();

        assert!(error.contains("refusing to overwrite newer unsupported record"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), newer);
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
    fn mobile_snapshot_defers_large_ocr_pages_but_keeps_page_count() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [{
                "id": "de-book",
                "title": "Buch",
                "text": "Sehr langer Text",
                "coverDataUrl": "data:image/jpeg;base64,cover",
                "pdfOcrPageCount": 0,
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
        assert!(snapshot["texts"][0].get("pdfOcrPages").is_none());
        assert_eq!(snapshot["texts"][0]["pdfOcrPageCount"], 1);
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
            serde_yaml::from_slice(&std::fs::read(record_path(dir.path(), record)).unwrap())
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
    fn profile_embedded_user_books_do_not_recreate_book_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut records = BTreeMap::new();
        records.insert(
            "profile:de".to_string(),
            SyncRecord {
                key: "profile:de".to_string(),
                kind: "profile".to_string(),
                data: json!({
                    "preferences": {},
                    "userBooks": [{ "id": "deleted-book", "title": "Deleted Book" }],
                    "vocab": {}
                }),
                updated_at: 1,
                deleted_at: None,
                device_id: "device-a".to_string(),
                causal: causal(&[("device-a", 1)]),
            },
        );

        let payload = records_to_payload(dir.path(), &records);

        assert_eq!(user_book_count(&payload), 0);
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
            &BTreeSet::new(),
        );
        let payload = records_to_payload(dir.path(), &merged.records);

        assert_eq!(merged.records["book:de:user-1"].kind, "book");
        assert_eq!(merged.records["book:de:user-1"].deleted_at, Some(3));
        assert_eq!(user_book_count(&payload), 0);
    }

    #[test]
    fn readded_record_descends_from_the_current_tombstone() {
        let key = "vocab:de:haus".to_string();
        let tombstone = SyncRecord {
            key: key.clone(),
            kind: "vocab".to_string(),
            data: Value::Null,
            updated_at: 9_999_999,
            deleted_at: Some(9_999_999),
            device_id: "remote-device".to_string(),
            causal: causal(&[("remote-device", 9)]),
        };
        let live = SyncRecord {
            key: key.clone(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 100,
            deleted_at: None,
            device_id: "local-device".to_string(),
            causal: BTreeMap::new(),
        };
        let mut incoming = [(key.clone(), live)].into_iter().collect();
        let current = [(key.clone(), tombstone)].into_iter().collect();

        prepare_local_records(
            &mut incoming,
            &BTreeMap::new(),
            &current,
            "local-device",
            100,
        );
        let full_keys = incoming
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let merged = merge_records(
            &BTreeMap::new(),
            incoming,
            current,
            "merge-device",
            101,
            &full_keys,
        );

        assert!(merged.records[&key].deleted_at.is_none());
        assert_eq!(merged.records[&key].causal.get("remote-device"), Some(&9));
        assert!(merged.records[&key].causal.get("local-device") >= Some(&100));
        assert!(merged.conflicts.is_empty());
    }

    #[test]
    fn stale_live_record_does_not_replace_an_unchanged_newer_tombstone() {
        let key = "vocab:de:haus".to_string();
        let tombstone = SyncRecord {
            key: key.clone(),
            kind: "vocab".to_string(),
            data: Value::Null,
            updated_at: 200,
            deleted_at: Some(200),
            device_id: "remote-device".to_string(),
            causal: causal(&[("remote-device", 9)]),
        };
        let stale_live = SyncRecord {
            key: key.clone(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 100,
            deleted_at: None,
            device_id: "local-device".to_string(),
            causal: causal(&[("local-device", 1)]),
        };
        let base = fingerprints(&[(key.clone(), tombstone.clone())].into_iter().collect());
        let incoming = [(key.clone(), stale_live)].into_iter().collect();
        let current = [(key.clone(), tombstone)].into_iter().collect();

        let merged = merge_records(
            &base,
            incoming,
            current,
            "merge-device",
            300,
            &[key.clone()].into_iter().collect(),
        );

        assert_eq!(merged.records[&key].deleted_at, Some(200));
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
            &BTreeSet::new(),
        );

        assert_eq!(merged.records["vocab:de:boot"].deleted_at, Some(3));
        assert!(merged.records["vocab:de:haus"].deleted_at.is_none());
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
            &BTreeSet::new(),
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
            &BTreeSet::new(),
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
            &BTreeSet::new(),
        );

        assert_eq!(
            merged.records["vocab:de:haus"].data["translation"],
            "laptop"
        );
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.conflicts[0]["reason"], "concurrent-record-changes");
    }

    #[test]
    fn concurrent_vocab_merge_keeps_later_status_and_newer_metadata() {
        let base_record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "status": "new", "translation": "base" }),
            updated_at: 1_000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let known = SyncRecord {
            data: json!({
                "status": "known",
                "statusUpdatedAt": "2026-07-23T12:00:00.000Z",
                "knownAt": "2026-07-23T12:00:00.000Z",
                "translation": "old translation"
            }),
            updated_at: 2_000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let edited_learning = SyncRecord {
            data: json!({
                "status": "learning",
                "statusUpdatedAt": "2026-07-23T10:00:00.000Z",
                "learningStartedAt": "2026-07-23T10:00:00.000Z",
                "translation": "new translation"
            }),
            updated_at: 5_000,
            device_id: "laptop-device".to_string(),
            causal: causal(&[("pc-device", 1), ("laptop-device", 2)]),
            ..base_record.clone()
        };
        let base = [(base_record.key.clone(), base_record)]
            .into_iter()
            .collect();

        let merge = |incoming: SyncRecord, current: SyncRecord, device: &str| {
            merge_records(
                &fingerprints(&base),
                [(incoming.key.clone(), incoming)].into_iter().collect(),
                [(current.key.clone(), current)].into_iter().collect(),
                device,
                6_000,
                &BTreeSet::new(),
            )
        };
        let first = merge(known.clone(), edited_learning.clone(), "phone-device");
        let second = merge(edited_learning, known, "laptop-device");

        for merged in [&first, &second] {
            let record = &merged.records["vocab:de:haus"];
            assert_eq!(record.data["status"], "known");
            assert_eq!(record.data["translation"], "new translation");
            assert_eq!(record.data["statusUpdatedAt"], "2026-07-23T12:00:00.000Z");
            assert!(record.data.get("learningStartedAt").is_none());
            assert_eq!(merged.conflicts.len(), 1);
            assert_eq!(merged.conflicts[0]["kept"]["data"]["status"], "known");
            assert_eq!(merged.conflicts[0]["conflict"]["data"]["status"], "known");
        }
    }

    #[test]
    fn canonical_live_survives_concurrent_legacy_alias_tombstone() {
        let live = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "status": "known", "translation": "house" }),
            updated_at: 10,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 10)]),
        };
        let legacy_alias = SyncRecord {
            key: "vocab:de:Haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "Haus", "status": "known", "translation": "house" }),
            updated_at: 10,
            deleted_at: Some(10),
            device_id: "device-b".to_string(),
            causal: causal(&[("device-b", 10)]),
        };

        let records = canonicalize_vocab_records(
            [
                (live.key.clone(), live.clone()),
                (legacy_alias.key.clone(), legacy_alias),
            ]
            .into_iter()
            .collect(),
        );

        let canonical = &records["vocab:de:haus"];
        assert!(canonical.deleted_at.is_none());
        assert_eq!(canonical.data["word"], "haus");
        assert_eq!(canonical.data["status"], "known");
    }

    #[test]
    fn concurrent_vocab_merge_allows_a_later_explicit_status_downgrade() {
        let known = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({
                "status": "known",
                "statusUpdatedAt": "2026-07-23T10:00:00.000Z",
                "knownAt": "2026-07-23T10:00:00.000Z",
                "translation": "new translation"
            }),
            updated_at: 5_000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 2)]),
        };
        let learning = SyncRecord {
            data: json!({
                "status": "learning",
                "statusUpdatedAt": "2026-07-23T12:00:00.000Z",
                "learningStartedAt": "2026-07-23T12:00:00.000Z",
                "nextDate": "2026-07-24",
                "translation": "old translation"
            }),
            updated_at: 2_000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("phone-device", 2)]),
            ..known.clone()
        };

        let merged = merge_records(
            &BTreeMap::new(),
            [(learning.key.clone(), learning)].into_iter().collect(),
            [(known.key.clone(), known)].into_iter().collect(),
            "phone-device",
            6_000,
            &BTreeSet::new(),
        );

        let record = &merged.records["vocab:de:haus"];
        assert_eq!(record.data["status"], "learning");
        assert_eq!(record.data["translation"], "new translation");
        assert_eq!(record.data["statusUpdatedAt"], "2026-07-23T12:00:00.000Z");
        assert_eq!(record.data["nextDate"], "2026-07-24");
    }

    #[test]
    fn concurrent_same_vocab_status_keeps_the_latest_status_clock() {
        let mut older = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({
                "status": "learning",
                "statusUpdatedAt": "2026-07-23T10:00:00.000Z",
                "learningStartedAt": "2026-07-23T10:00:00.000Z",
                "nextDate": "2026-07-24",
                "lastReviewedAt": "2026-07-23T10:00:00.000Z"
            }),
            updated_at: 5_000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 2)]),
        };
        let newer = SyncRecord {
            data: json!({
                "status": "learning",
                "statusUpdatedAt": "2026-07-23T12:00:00.000Z",
                "learningStartedAt": "2026-07-23T12:00:00.000Z",
                "nextDate": "2026-07-25",
                "lastReviewedAt": "2026-07-23T12:00:00.000Z"
            }),
            updated_at: 2_000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("phone-device", 2)]),
            ..older.clone()
        };

        assert!(merge_vocab_status(&mut older, &newer));
        assert!(merge_vocab_schedule(&mut older, &newer));
        assert_eq!(older.data["statusUpdatedAt"], "2026-07-23T12:00:00.000Z");
        assert_eq!(older.data["nextDate"], "2026-07-25");
    }

    #[test]
    fn concurrent_reader_bookmark_additions_are_unioned_and_survive_resolution() {
        let base_record = SyncRecord {
            key: "pref:readerBookmarks".to_string(),
            kind: "pref".to_string(),
            data: json!({ "book": [{ "id": "base", "page": 1 }] }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let incoming = SyncRecord {
            data: json!({ "book": [
                { "id": "base", "page": 1 },
                { "id": "phone", "page": 2 }
            ] }),
            updated_at: 2000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: json!({ "book": [
                { "id": "base", "page": 1 },
                { "id": "laptop", "page": 3 }
            ] }),
            updated_at: 3000,
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
            "merge-device",
            6000,
            &BTreeSet::new(),
        );
        let merged_record = &merged.records["pref:readerBookmarks"];
        let ids = merged_record.data["book"]
            .as_array()
            .unwrap()
            .iter()
            .map(value_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            ids,
            BTreeSet::from(["base".into(), "laptop".into(), "phone".into()])
        );
        assert_eq!(merged_record.causal["phone-device"], 2);
        assert_eq!(merged_record.causal["laptop-device"], 2);
        assert_eq!(merged.conflicts.len(), 1);
    }

    #[test]
    fn concurrent_large_reader_bookmark_sets_merge_to_one_thousand() {
        let make_data = |prefix: &str| {
            let mut books = serde_json::Map::new();
            for book_index in 0..5 {
                books.insert(
                    format!("book-{book_index}"),
                    Value::Array(
                        (0..100)
                            .map(|index| {
                                json!({
                                    "id": format!("{prefix}-{book_index}-{index}"),
                                    "label": format!("Bookmark {index}"),
                                    "page": index / 20 + 1,
                                    "wordIndex": index
                                })
                            })
                            .collect(),
                    ),
                );
            }
            Value::Object(books)
        };
        let base_record = SyncRecord {
            key: "pref:readerBookmarks".to_string(),
            kind: "pref".to_string(),
            data: json!({}),
            updated_at: 1000,
            deleted_at: None,
            device_id: "base-device".to_string(),
            causal: causal(&[("base-device", 1)]),
        };
        let incoming = SyncRecord {
            data: make_data("phone"),
            updated_at: 2000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("base-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: make_data("laptop"),
            updated_at: 3000,
            device_id: "laptop-device".to_string(),
            causal: causal(&[("base-device", 1), ("laptop-device", 2)]),
            ..base_record.clone()
        };
        let base = [(base_record.key.clone(), base_record)]
            .into_iter()
            .collect();
        let started = std::time::Instant::now();
        let merged = merge_records(
            &fingerprints(&base),
            [(incoming.key.clone(), incoming)].into_iter().collect(),
            [(current.key.clone(), current)].into_iter().collect(),
            "merge-device",
            6000,
            &BTreeSet::new(),
        );
        let books = merged.records["pref:readerBookmarks"]
            .data
            .as_object()
            .unwrap();
        let counts = books
            .values()
            .map(|bookmarks| bookmarks.as_array().unwrap().len())
            .collect::<Vec<_>>();

        eprintln!("merged 1000 Reader bookmarks in {:?}", started.elapsed());
        assert_eq!(counts, vec![200, 200, 200, 200, 200]);
        assert_eq!(counts.iter().sum::<usize>(), 1000);
        assert_eq!(merged.conflicts.len(), 1);
    }

    #[test]
    fn concurrent_reader_bookmark_deletion_is_not_resurrected_by_union() {
        let base_record = SyncRecord {
            key: "pref:readerBookmarks".to_string(),
            kind: "pref".to_string(),
            data: json!({ "book": [{ "id": "removed", "page": 1 }] }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let incoming = SyncRecord {
            data: json!({ "book": [
                { "id": "removed", "page": 1 },
                { "id": "phone", "page": 2 }
            ] }),
            updated_at: 2000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: json!({ "book": [] }),
            updated_at: 3000,
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
            "merge-device",
            6000,
            &BTreeSet::new(),
        );

        assert_eq!(
            merged.records["pref:readerBookmarks"].data["book"],
            json!([{ "id": "phone", "page": 2 }])
        );
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(
            merged.conflicts[0]["conflict"]["data"]["book"],
            json!([{ "id": "phone", "page": 2 }])
        );
    }

    #[test]
    fn concurrent_reader_bookmark_edit_is_preserved_in_delete_conflict() {
        let base_record = SyncRecord {
            key: "pref:readerBookmarks".to_string(),
            kind: "pref".to_string(),
            data: json!({ "book": [{ "id": "a", "label": "old", "page": 1 }] }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let incoming = SyncRecord {
            data: json!({ "book": [{ "id": "a", "label": "edited", "color": "purple", "page": 1 }] }),
            updated_at: 2000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: json!({ "book": [] }),
            updated_at: 3000,
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
            "merge-device",
            6000,
            &BTreeSet::new(),
        );

        assert!(
            merged.records["pref:readerBookmarks"]
                .data
                .get("book")
                .is_none()
        );
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(
            merged.conflicts[0]["conflict"]["data"]["book"],
            json!([{ "id": "a", "label": "edited", "color": "purple", "page": 1 }])
        );
    }

    #[test]
    fn concurrent_bookmark_edit_survives_an_unrelated_addition() {
        let base_record = SyncRecord {
            key: "pref:readerBookmarks".to_string(),
            kind: "pref".to_string(),
            data: json!({ "book": [{ "id": "a", "label": "old", "page": 1 }] }),
            updated_at: 1000,
            deleted_at: None,
            device_id: "pc-device".to_string(),
            causal: causal(&[("pc-device", 1)]),
        };
        let incoming = SyncRecord {
            data: json!({ "book": [{ "id": "a", "label": "edited", "color": "purple", "page": 1 }] }),
            updated_at: 2000,
            device_id: "phone-device".to_string(),
            causal: causal(&[("pc-device", 1), ("phone-device", 2)]),
            ..base_record.clone()
        };
        let current = SyncRecord {
            data: json!({ "book": [
                { "id": "a", "label": "old", "page": 1 },
                { "id": "b", "label": "new", "page": 2 }
            ] }),
            updated_at: 3000,
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
            "merge-device",
            6000,
            &BTreeSet::new(),
        );
        let bookmarks = merged.records["pref:readerBookmarks"].data["book"]
            .as_array()
            .unwrap();

        assert_eq!(bookmarks.len(), 2);
        assert_eq!(bookmarks[0]["id"], "a");
        assert_eq!(bookmarks[0]["label"], "edited");
        assert_eq!(bookmarks[0]["color"], "purple");
        assert_eq!(bookmarks[1]["id"], "b");
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
            &BTreeSet::new(),
        );

        assert!(merged.records["vocab:de:haus"].deleted_at.is_some());
        assert_eq!(merged.conflicts.len(), 1);
        assert_eq!(merged.conflicts[0]["reason"], "concurrent-record-changes");
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

        let merged = merge_records(
            &base,
            incoming_records,
            current_records,
            "z-device",
            11,
            &BTreeSet::new(),
        );

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
            &BTreeSet::new(),
        );
        let second = merge_records(
            &base,
            [(a_record.key.clone(), a_record)].into_iter().collect(),
            [(z_record.key.clone(), z_record)].into_iter().collect(),
            "a-device",
            11,
            &BTreeSet::new(),
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
            &BTreeSet::new(),
        );
        let second = merge_records(
            &base,
            [(update.key.clone(), update)].into_iter().collect(),
            [(tombstone.key.clone(), tombstone)].into_iter().collect(),
            "a-device",
            11,
            &BTreeSet::new(),
        );

        assert_eq!(first.records["vocab:de:haus"].deleted_at, Some(10));
        assert_eq!(second.records["vocab:de:haus"].deleted_at, Some(10));
        assert_eq!(first.conflicts.len(), 1);
        assert_eq!(second.conflicts.len(), 1);
    }

    #[test]
    fn tombstone_all_replaces_live_record_backups_with_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let live = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 1,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 1), ("remote-device", 9)]),
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
        let loaded = load_records(dir.path()).unwrap();

        assert!(loaded["vocab:de:haus"].deleted_at.is_some());
        assert_eq!(
            loaded["vocab:de:haus"].causal.get("remote-device"),
            Some(&9)
        );
        let recovery_backup = record_path.with_extension("bak");
        assert!(recovery_backup.exists());
        assert!(
            parse_record_file(&recovery_backup)
                .unwrap()
                .deleted_at
                .is_some()
        );
        std::fs::remove_file(&record_path).unwrap();
        assert!(recovery_backup.exists());
        let recovered = load_records(dir.path()).unwrap();
        assert!(recovered["vocab:de:haus"].deleted_at.is_some());
        assert_eq!(
            recovered["vocab:de:haus"].causal.get("remote-device"),
            Some(&9)
        );
    }

    #[test]
    fn rewriting_tombstone_repairs_a_corrupt_primary_without_destroying_backup() {
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
        write_record(dir.path(), &live).unwrap();
        tombstone_all(dir.path(), "device-a").unwrap();

        let path = record_path(dir.path(), &live);
        let tombstone = parse_record_file(&path).unwrap();
        let backup = path.with_extension("bak");
        assert!(parse_record_file(&backup).unwrap().deleted_at.is_some());
        std::fs::write(&path, b"{corrupt primary").unwrap();

        write_record(dir.path(), &tombstone).unwrap();

        assert!(parse_record_file(&path).unwrap().deleted_at.is_some());
        assert!(parse_record_file(&backup).unwrap().deleted_at.is_some());
    }

    #[test]
    fn corrupt_primary_does_not_hide_a_future_format_recovery_backup() {
        let dir = tempfile::tempdir().unwrap();
        let record = SyncRecord {
            key: "vocab:de:haus".to_string(),
            kind: "vocab".to_string(),
            data: json!({ "word": "haus", "translation": "house" }),
            updated_at: 1,
            deleted_at: None,
            device_id: "device-a".to_string(),
            causal: causal(&[("device-a", 1)]),
        };
        let path = record_path(dir.path(), &record);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{corrupt primary").unwrap();
        let future = br#"{"format":99,"schemaVersion":99,"key":"vocab:de:haus"}"#;
        let backup = path.with_extension("bak");
        std::fs::write(&backup, future).unwrap();

        let error = write_record(dir.path(), &record).unwrap_err();

        assert!(error.contains("newer unsupported record"));
        assert_eq!(std::fs::read(&backup).unwrap(), future);
    }
}
