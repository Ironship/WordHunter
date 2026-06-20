use super::*;
use serde_json::json;

#[test]
fn sm2_review_sets_due_date() {
    let result = review(json!({
        "quality": 5,
        "today": "2026-06-16",
        "now": "2026-06-16T12:00:00Z",
        "entry": {}
    }))
    .unwrap();

    assert_eq!(result["srsAlgorithm"], "sm2");
    assert_eq!(result["interval"], 1);
    assert_eq!(result["nextDate"], "2026-06-17");
}

#[test]
fn fsrs_review_uses_fsrs_shape() {
    let result = review(json!({
        "quality": 4,
        "algorithm": "fsrs",
        "today": "2026-06-16",
        "now": "2026-06-16T12:00:00Z",
        "entry": {}
    }))
    .unwrap();

    assert_eq!(result["srsAlgorithm"], "fsrs");
    assert!(result["repetition"].as_i64().is_some());
    let interval = result["interval"].as_i64().unwrap();
    assert!(interval >= 1, "interval {interval} should be >= 1");
    let stability = result["stability"].as_f64().unwrap();
    let difficulty = result["difficulty"].as_f64().unwrap();
    assert!((1.0..=10.0).contains(&stability), "stability {stability} out of range");
    assert!((1.0..=10.0).contains(&difficulty), "difficulty {difficulty} out of range");
    let next_date = result["nextDate"].as_str().unwrap();
    assert!(next_date > "2026-06-16", "nextDate {next_date} should be in the future");
}

#[test]
fn today_iso_format() {
    let dt = OffsetDateTime::parse("2026-06-16T00:00:00Z", &Rfc3339).unwrap();
    assert_eq!(today_iso(dt), "2026-06-16");
}

#[test]
fn add_days_iso_from_advances_date() {
    let dt = OffsetDateTime::parse("2026-06-16T12:00:00Z", &Rfc3339).unwrap();
    assert_eq!(add_days_iso_from(3, dt), "2026-06-19");
    assert_eq!(add_days_iso_from(0, dt), "2026-06-16");
    assert_eq!(add_days_iso_from(-5, dt), "2026-06-16");
}

#[test]
fn is_due_treats_empty_and_missing_as_due() {
    assert!(is_due(None, "2026-06-16"));
    assert!(is_due(Some(""), "2026-06-16"));
    assert!(is_due(Some("2026-06-15"), "2026-06-16"));
    assert!(is_due(Some("2026-06-16"), "2026-06-16"));
    assert!(!is_due(Some("2026-06-17"), "2026-06-16"));
    assert!(!is_due(Some("2027-01-01"), "2026-06-16"));
}

#[test]
fn ensure_sm2_fields_fills_defaults() {
    let mut entry = json!({});
    ensure_sm2_fields(&mut entry, "2026-06-16");
    assert_eq!(entry["interval"], 0);
    assert_eq!(entry["repetition"], 0);
    assert_eq!(entry["efactor"], 2.5);
    assert_eq!(entry["stability"], 0.0);
    assert_eq!(entry["difficulty"], 5.0);
    assert_eq!(entry["srsAlgorithm"], "sm2");
    assert_eq!(entry["nextDate"], "2026-06-16");
}

#[test]
fn ensure_sm2_fields_preserves_existing() {
    let mut entry = json!({
        "interval": 7,
        "repetition": 3,
        "efactor": 2.7,
        "stability": 12.5,
        "difficulty": 4.2,
        "srsAlgorithm": "fsrs",
        "nextDate": "2026-07-01",
    });
    ensure_sm2_fields(&mut entry, "2026-06-16");
    assert_eq!(entry["interval"], 7);
    assert_eq!(entry["repetition"], 3);
    assert_eq!(entry["efactor"], 2.7);
    assert_eq!(entry["srsAlgorithm"], "fsrs");
    assert_eq!(entry["nextDate"], "2026-07-01");
}
