mod date;
mod fsrs;
mod sm2;

use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use self::date::{add_days_iso, today_from_iso};
use self::fsrs::calculate_fsrs;
use self::sm2::calculate_sm2;

pub fn review(payload: Value) -> Result<Value, String> {
    // Reject garbage: a review without a quality grade or without an entry
    // must not fabricate plausible scheduling data (success-on-garbage).
    if payload.get("quality").and_then(Value::as_f64).is_none() {
        return Err("srs review requires a quality grade".to_string());
    }
    if payload.get("entry").is_none() || payload.get("entry") == Some(&Value::Null) {
        return Err("srs review requires an entry".to_string());
    }
    let quality = payload
        .get("quality")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !quality.is_finite() || !(0.0..=5.0).contains(&quality) {
        return Err("srs quality must be between 0 and 5".to_string());
    }
    let entry = payload.get("entry").unwrap_or(&Value::Null);
    if !entry.is_object() {
        return Err("srs review entry must be an object".to_string());
    }
    let algorithm = payload
        .get("algorithm")
        .and_then(Value::as_str)
        .unwrap_or("sm2");
    let mode = match algorithm {
        "sm2" => "sm2",
        "fsrs" => "fsrs",
        _ => return Err("unsupported srs algorithm".to_string()),
    };
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
