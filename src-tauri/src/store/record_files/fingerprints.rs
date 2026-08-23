use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use super::io::stable_hash;
use super::merge::is_vocab_alias_retirement;
use super::model::{Fingerprints, RecordFingerprint, SyncRecord};

static LAST_CLOCK_MS: AtomicU64 = AtomicU64::new(0);

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

pub(crate) fn fingerprint(record: &SyncRecord) -> String {
    let value = json!({
        "key": record.key,
        "kind": record.kind,
        "deleted": record.deleted_at.is_some(),
        "data": record.data,
    });
    stable_hash(&serde_json::to_string(&value).unwrap_or_default())
}

/// True when the record's content differs from the in-memory base snapshot.
/// Used by the delta save path to write only the records that actually
/// changed, instead of re-opening every record file on disk.
pub(crate) fn record_changed_since_base(record: &SyncRecord, base: &Fingerprints) -> bool {
    base.get(&record.key)
        .map(|entry| entry.hash != fingerprint(record))
        .unwrap_or(true)
}
