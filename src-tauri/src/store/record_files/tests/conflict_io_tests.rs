//! Half of the former inline `mod tests` (part 2); split verbatim.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::{
    SyncRecord, canonicalize_vocab_records, fingerprints, kind_dir, load_records, merge_records,
    merge_vocab_schedule, merge_vocab_status, parse_record_file, read_existing_record, record_path,
    record_value, records_root, stable_hash, text_content, tombstone_all, value_id, write_record,
    write_records,
};

use super::record_files_helpers::{
    causal, fnv1a_name, single_pref_record, write_legacy_fnv_record,
};
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

#[test]
fn new_record_writes_use_sha256_filenames() {
    let dir = tempfile::tempdir().unwrap();
    let record = single_pref_record();
    write_record(dir.path(), &record).unwrap();

    let path = record_path(dir.path(), &record);
    let name = path.file_stem().unwrap().to_str().unwrap();
    assert_eq!(
        name.len(),
        64,
        "record filename should be a full SHA-256 hex digest"
    );
    assert!(name.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(name, stable_hash(&record.key));
    let legacy = records_root(dir.path())
        .join(kind_dir(&record.kind))
        .join(format!("{}.yaml", fnv1a_name(&record.key)));
    assert!(
        !legacy.exists(),
        "new writes must not leave FNV-named files"
    );
}

#[test]
fn stable_hash_is_deterministic_sha256() {
    let first = stable_hash("vocab:de:haus");
    let second = stable_hash("vocab:de:haus");
    let other = stable_hash("vocab:de:haus2");
    assert_eq!(first, second);
    assert_ne!(first, other);
    assert_eq!(first.len(), 64);
    assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn load_records_still_reads_legacy_fnv_filenames() {
    let dir = tempfile::tempdir().unwrap();
    let record = single_pref_record();
    let legacy = write_legacy_fnv_record(dir.path(), &record);

    let loaded = load_records(dir.path()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[&record.key].key, record.key);
    assert_eq!(loaded[&record.key].data, record.data);
    assert!(legacy.exists());
}

#[test]
fn text_and_existing_record_readers_accept_legacy_fnv_filenames() {
    let dir = tempfile::tempdir().unwrap();
    let record = SyncRecord {
        key: "text:doc-1".to_string(),
        kind: "text".to_string(),
        data: json!({ "text": "hello" }),
        updated_at: 1,
        deleted_at: None,
        device_id: "device-a".to_string(),
        causal: causal(&[("device-a", 1)]),
    };
    let legacy = write_legacy_fnv_record(dir.path(), &record);

    assert_eq!(
        text_content(dir.path(), "doc-1").unwrap().as_deref(),
        Some("hello")
    );
    let direct = read_existing_record(dir.path(), "text", &record.key).unwrap();
    assert_eq!(direct.as_ref().map(|record| &record.key), Some(&record.key));
    assert!(legacy.exists());
}

#[test]
fn write_after_reading_legacy_fnv_record_migrates_to_sha256() {
    let dir = tempfile::tempdir().unwrap();
    let record = single_pref_record();
    let legacy = write_legacy_fnv_record(dir.path(), &record);

    let loaded = load_records(dir.path()).unwrap();
    write_records(dir.path(), &loaded).unwrap();

    let sha_path = record_path(dir.path(), &record);
    assert!(
        sha_path.exists(),
        "rewrite should create the SHA-256-named file"
    );
    assert!(
        !legacy.exists(),
        "rewrite should remove the legacy FNV-named file"
    );
    let reloaded = load_records(dir.path()).unwrap();
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[&record.key].data, record.data);
}

#[test]
fn write_record_removes_legacy_fnv_backup_at_its_real_path() {
    let dir = tempfile::tempdir().unwrap();
    let record = single_pref_record();
    let legacy = write_legacy_fnv_record(dir.path(), &record);
    // durable::write_file_atomic keeps a `<stem>.bak` next to the primary
    // whenever a save replaces an existing file, so stores that were
    // written more than once before the migration carry a legacy backup.
    let legacy_backup = legacy.with_extension("bak");
    let stale = SyncRecord {
        data: json!({ "theme": "light" }),
        ..record.clone()
    };
    std::fs::write(
        &legacy_backup,
        serde_yaml::to_string(&record_value(&stale)).unwrap(),
    )
    .unwrap();
    assert!(legacy.exists() && legacy_backup.exists());

    write_record(dir.path(), &record).unwrap();

    let sha_path = record_path(dir.path(), &record);
    assert!(
        sha_path.exists(),
        "save should write the SHA-256-named file"
    );
    assert!(
        !legacy.exists(),
        "save should remove the legacy FNV-named primary"
    );
    assert!(
        !legacy_backup.exists(),
        "save should also remove the legacy FNV-named backup next to it"
    );
    let kind_dir_path = sha_path.parent().unwrap();
    let remaining = std::fs::read_dir(kind_dir_path).unwrap().count();
    assert_eq!(
        remaining, 1,
        "only the SHA-256-named file should remain in the record directory"
    );
}

#[test]
fn load_records_does_not_promote_orphaned_backup_over_sha_primary() {
    let dir = tempfile::tempdir().unwrap();
    let record = single_pref_record();
    // State left behind by the pre-fix migration: the legacy FNV primary
    // was removed on save, but its backup was orphaned because the
    // removal looked in the wrong directory. A fresh SHA-256 primary now
    // holds the newer content under the same key.
    let sha_path = record_path(dir.path(), &record);
    std::fs::create_dir_all(sha_path.parent().unwrap()).unwrap();
    std::fs::write(
        &sha_path,
        serde_yaml::to_string(&record_value(&record)).unwrap(),
    )
    .unwrap();
    let stale = SyncRecord {
        data: json!({ "theme": "light" }),
        ..record.clone()
    };
    let orphaned_backup = records_root(dir.path())
        .join(kind_dir(&record.kind))
        .join(format!("{}.bak", fnv1a_name(&record.key)));
    std::fs::write(
        &orphaned_backup,
        serde_yaml::to_string(&record_value(&stale)).unwrap(),
    )
    .unwrap();

    let loaded = load_records(dir.path()).unwrap();

    assert_eq!(loaded.len(), 1);
    assert_eq!(
        loaded[&record.key].data, record.data,
        "a recovery backup must never override a live primary for the same key"
    );
}
