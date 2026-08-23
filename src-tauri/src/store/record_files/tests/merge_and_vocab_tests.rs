//! Half of the former inline `mod tests` (part 1); split verbatim.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::{
    FORMAT, PAYLOAD_SCHEMA_VERSION, SyncRecord, canonicalize_vocab_records, fingerprints,
    live_record, load_records, merge_records, merge_vocab_entry_data, parse_record,
    payload_to_records, prepare_local_records, read_record_file, record_path,
    records_to_mobile_snapshot_payload, records_to_payload, records_to_snapshot_payload,
    recovery_status, write_records,
};

use super::record_files_helpers::{causal, user_book_count, user_book_payload, vocab_payload};
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
        serde_yaml::from_slice(&std::fs::read(record_path(dir.path(), record)).unwrap()).unwrap();

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
