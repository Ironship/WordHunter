//! Test-only fixture builders for `record_files` tests.
//!
//! Pulled into `record_files.rs` with `#[cfg(test)] #[path = "tests/record_files_helpers.rs"]`
//! so these helpers keep private access to that module's items while the
//! 4000+-line god module stays reviewable. Nothing here compiles in
//! production builds.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{SyncRecord, kind_dir, payload_to_records, record_value, records_root};

/// Compact causal-clock literal for merging tests.
pub(super) fn causal(entries: &[(&str, u64)]) -> BTreeMap<String, u64> {
    entries
        .iter()
        .map(|(device, counter)| ((*device).to_string(), *counter))
        .collect()
}

/// A full mobile-snapshot-shaped payload with the given `userBooks` value.
pub(super) fn user_book_payload(user_books: Value) -> Value {
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

pub(super) fn user_book_count(payload: &Value) -> usize {
    payload["vocab"]["de"]
        .get("userBooks")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

/// A full payload whose `de` vocab entry contains one known entry per word.
pub(super) fn vocab_payload(words: &[&str]) -> Value {
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

/// FNV-1a 64-bit filename scheme used by builds before the SHA-256
/// migration; kept in tests to prove dual-read and on-disk migration.
pub(super) fn fnv1a_name(key: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Write a record under its legacy FNV-1a filename, returning that path.
pub(super) fn write_legacy_fnv_record(dir: &Path, record: &SyncRecord) -> PathBuf {
    let path = records_root(dir)
        .join(kind_dir(&record.kind))
        .join(format!("{}.yaml", fnv1a_name(&record.key)));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_yaml::to_string(&record_value(record)).unwrap()).unwrap();
    path
}

/// The single `prefs` record produced from a minimal payload.
pub(super) fn single_pref_record() -> SyncRecord {
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
    records.values().next().unwrap().clone()
}
