use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use super::model::CausalClock;

pub(crate) fn merge_causal_clock(target: &mut CausalClock, source: &CausalClock) {
    for (device, counter) in source {
        target
            .entry(device.clone())
            .and_modify(|value| *value = (*value).max(*counter))
            .or_insert(*counter);
    }
}

pub(crate) fn legacy_causal_clock(
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CausalOrder {
    IncomingDescends,
    CurrentDescends,
    Concurrent,
    Equal,
}

pub(crate) fn compare_causal(incoming: &CausalClock, current: &CausalClock) -> CausalOrder {
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

pub(crate) fn causal_from_event(device_id: &str, now: u128) -> CausalClock {
    let mut causal = CausalClock::new();
    bump_causal(&mut causal, device_id, now);
    causal
}

pub(crate) fn bump_causal(causal: &mut CausalClock, device_id: &str, now: u128) {
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

pub(crate) fn parse_causal(value: Option<&Value>) -> Result<CausalClock, String> {
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
