use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::causal::{CausalOrder, bump_causal, compare_causal, merge_causal_clock};
use super::fingerprints::fingerprint;
use super::io::record_value;
use super::model::{
    CausalClock, Fingerprints, MergeResult, SyncRecord, infer_kind, parse_lang_key, value_id,
};
use crate::tokenizer;

const IN_TEXT_REVIEW_COMPLETIONS_KEY: &str = "pref:inTextReviewCompletedGuesses";

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

pub(crate) fn merge_vocab_status(existing: &mut SyncRecord, source: &SyncRecord) -> bool {
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

pub(crate) fn merge_vocab_schedule(existing: &mut SyncRecord, source: &SyncRecord) -> bool {
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

pub(crate) fn merge_vocab_entry_data(existing: &mut Value, source: &Value) -> bool {
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

pub(crate) fn is_vocab_alias_retirement(data: &Value) -> bool {
    data.get(VOCAB_ALIAS_MARKER)
        .and_then(Value::as_str)
        .is_some()
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

pub(crate) fn canonicalize_vocab_records(
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

pub(crate) fn tombstone_with_base(
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
