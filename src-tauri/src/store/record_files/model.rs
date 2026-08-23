use serde_json::Value;
use std::collections::BTreeMap;

use super::causal::causal_from_event;

pub(crate) const FORMAT: u64 = 1;
pub(crate) const PAYLOAD_SCHEMA_VERSION: u64 = 2;

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
    // Retained for merge diagnostics and regression assertions; production
    // callers currently persist only the resolved record set.
    #[cfg_attr(not(test), allow(dead_code))]
    pub conflicts: Vec<Value>,
}

pub(crate) fn live_record(
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

pub(crate) fn infer_kind(key: &str) -> &str {
    key.split_once(':')
        .map(|(kind, _)| kind)
        .unwrap_or("record")
}

pub(crate) fn parse_lang_key<'a>(key: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    key.strip_prefix(prefix)?.split_once(':')
}

pub(crate) fn value_id(value: &Value) -> String {
    value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
