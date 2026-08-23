use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use super::merge::merge_vocab_entry_data;
use super::model::{PAYLOAD_SCHEMA_VERSION, SyncRecord, live_record, parse_lang_key, value_id};
use crate::tokenizer;

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
