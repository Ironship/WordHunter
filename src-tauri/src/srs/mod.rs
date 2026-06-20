mod date;
mod fsrs;
mod sm2;

use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use self::date::{add_days_iso, today_from_iso};
use self::fsrs::calculate_fsrs;
use self::sm2::calculate_sm2;

pub use self::date::{add_days_iso_from, is_due, today_iso};

pub fn review(payload: Value) -> Result<Value, String> {
    let quality = payload
        .get("quality")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let entry = payload.get("entry").unwrap_or(&Value::Null);
    let algorithm = payload
        .get("algorithm")
        .and_then(Value::as_str)
        .unwrap_or("sm2");
    let mode = if algorithm == "fsrs" { "fsrs" } else { "sm2" };
    let now_iso = payload
        .get("now")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        });
    let today = payload
        .get("today")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| today_from_iso(&now_iso));

    let schedule = if mode == "fsrs" {
        calculate_fsrs(quality, entry, &now_iso)
    } else {
        calculate_sm2(quality, entry)
    };
    let interval = schedule
        .get("interval")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .max(0);
    let mut result = schedule;
    result["nextDate"] = json!(add_days_iso(&today, interval));
    result["lastReviewedAt"] = json!(now_iso);
    result["srsAlgorithm"] = json!(mode);
    Ok(result)
}

pub fn ensure_sm2_fields(entry: &mut Value, today: &str) {
    if entry.get("interval").and_then(Value::as_i64).is_none() {
        entry["interval"] = json!(0);
    }
    if entry.get("repetition").and_then(Value::as_i64).is_none() {
        entry["repetition"] = json!(0);
    }
    if entry.get("efactor").and_then(Value::as_f64).is_none() {
        entry["efactor"] = json!(2.5);
    }
    if entry.get("stability").and_then(Value::as_f64).is_none() {
        entry["stability"] = json!(0);
    }
    if entry.get("difficulty").and_then(Value::as_f64).is_none() {
        entry["difficulty"] = json!(5);
    }
    if entry.get("srsAlgorithm").and_then(Value::as_str) != Some("fsrs") {
        entry["srsAlgorithm"] = json!("sm2");
    }
    if entry.get("nextDate").and_then(Value::as_str).is_none() {
        entry["nextDate"] = json!(today);
    }
}

pub fn handle_ensure(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("ensure");
    match op {
        "ensure" => {
            let today = payload
                .get("today")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    OffsetDateTime::now_utc()
                        .format(&time::format_description::well_known::Rfc3339)
                        .map(|s| s[..10].to_string())
                        .unwrap_or_else(|_| "1970-01-01".to_string())
                });
            let mut entry = payload
                .get("entry")
                .cloned()
                .ok_or_else(|| "missing entry".to_string())?;
            ensure_sm2_fields(&mut entry, &today);
            Ok(entry)
        }
        "today" => {
            let now = payload
                .get("now")
                .and_then(Value::as_str)
                .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
                .unwrap_or_else(OffsetDateTime::now_utc);
            Ok(json!({ "today": today_iso(now) }))
        }
        "add_days" => {
            let days = payload.get("days").and_then(Value::as_i64).unwrap_or(0);
            let now = payload
                .get("now")
                .and_then(Value::as_str)
                .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
                .unwrap_or_else(OffsetDateTime::now_utc);
            Ok(json!({ "date": add_days_iso_from(days, now) }))
        }
        "is_due" => {
            let today = payload
                .get("today")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    OffsetDateTime::now_utc()
                        .format(&time::format_description::well_known::Rfc3339)
                        .map(|s| s[..10].to_string())
                        .unwrap_or_else(|_| "1970-01-01".to_string())
                });
            let next_date = payload.get("nextDate").and_then(Value::as_str);
            Ok(json!({
                "nextDate": next_date.unwrap_or(""),
                "today": today,
                "is_due": is_due(next_date, &today),
            }))
        }
        other => Err(format!("unknown srs op: {other}")),
    }
}

// Shared helpers used by both sm2 and fsrs algorithms

pub(crate) fn normalize_quality(quality: f64) -> i64 {
    (quality.round() as i64).clamp(0, 5)
}

pub(crate) fn finite_f64(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

pub(crate) fn finite_i64(value: &Value, key: &str) -> Option<i64> {
    finite_f64(value, key).map(|n| n as i64)
}

pub(crate) fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10_f64.powi(digits);
    (value * factor).round() / factor
}

#[cfg(test)]
#[path = "../tests/srs/tests.rs"]
mod tests;
