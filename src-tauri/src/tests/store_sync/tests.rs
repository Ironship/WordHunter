use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{Value, json};

use super::{Store, StoreInner};

fn store_at(dir: &tempfile::TempDir, device_id: &str) -> Store {
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

fn payload(status: &str, status_updated_at: &str, translation: &str, note: &str) -> Value {
    json!({
        "schemaVersion": 2,
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
                    "haus": {
                        "word": "haus",
                        "status": status,
                        "statusUpdatedAt": status_updated_at,
                        "translation": translation,
                        "note": note
                    }
                }
            }
        }
    })
}

#[test]
fn two_stores_keep_known_status_when_stale_learning_metadata_is_saved_later() {
    let a_dir = tempfile::tempdir().unwrap();
    let b_dir = tempfile::tempdir().unwrap();
    let remote = tempfile::tempdir().unwrap();
    let a = store_at(&a_dir, "device-a");
    let b = store_at(&b_dir, "device-b");

    a.bulk_save(payload(
        "learning",
        "2026-07-23T10:00:00.000Z",
        "house",
        "initial",
    ))
    .unwrap();
    let a_initial = a.sync_with_directory(remote.path().to_path_buf()).unwrap();
    a.acknowledge_frontend_snapshot(&a_initial).unwrap();
    let b_initial = b.sync_with_directory(remote.path().to_path_buf()).unwrap();
    b.acknowledge_frontend_snapshot(&b_initial).unwrap();

    b.bulk_save(payload(
        "known",
        "2026-07-23T12:00:00.000Z",
        "house",
        "initial",
    ))
    .unwrap();
    let b_known = b.sync_with_directory(remote.path().to_path_buf()).unwrap();
    b.acknowledge_frontend_snapshot(&b_known).unwrap();

    a.bulk_save(payload(
        "learning",
        "2026-07-23T10:00:00.000Z",
        "home; house",
        "metadata edited later",
    ))
    .unwrap();
    let a_merged = a.sync_with_directory(remote.path().to_path_buf()).unwrap();
    a.acknowledge_frontend_snapshot(&a_merged).unwrap();
    let b_merged = b.sync_with_directory(remote.path().to_path_buf()).unwrap();
    b.acknowledge_frontend_snapshot(&b_merged).unwrap();

    a.bulk_save(payload(
        "learning",
        "2026-07-23T10:00:00.000Z",
        "dwelling; home; house",
        "metadata edited after merge",
    ))
    .unwrap();
    let a_descendant = a.sync_with_directory(remote.path().to_path_buf()).unwrap();
    a.acknowledge_frontend_snapshot(&a_descendant).unwrap();
    let b_descendant = b.sync_with_directory(remote.path().to_path_buf()).unwrap();
    b.acknowledge_frontend_snapshot(&b_descendant).unwrap();

    for snapshot in [a.snapshot_unacknowledged(), b.snapshot_unacknowledged()] {
        let entry = &snapshot["vocab"]["de"]["vocab"]["haus"];
        assert_eq!(entry["status"], "known");
        assert_eq!(entry["statusUpdatedAt"], "2026-07-23T12:00:00.000Z");
        assert_eq!(entry["translation"], "dwelling; home; house");
        assert_eq!(entry["note"], "metadata edited after merge");
    }
}
