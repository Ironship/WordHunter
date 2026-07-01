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
    assert_eq!(result["repetition"], 1);
    assert_eq!(result["interval"], 1);
    assert_eq!(result["efactor"], 2.6);
    assert_eq!(result["nextDate"], "2026-06-17");
    assert_eq!(result["lastReviewedAt"], "2026-06-16T12:00:00Z");
}

#[test]
fn sm2_review_uses_exact_grade_intervals() {
    for (quality, entry, expected_repetition, expected_interval, expected_efactor, expected_date) in [
        (1, json!({}), 0, 1, 1.96, "2026-06-17"),
        (3, json!({}), 1, 1, 2.36, "2026-06-17"),
        (
            5,
            json!({ "repetition": 1, "interval": 1, "efactor": 2.5 }),
            2,
            6,
            2.6,
            "2026-06-22",
        ),
    ] {
        let result = review(json!({
            "quality": quality,
            "today": "2026-06-16",
            "now": "2026-06-16T12:00:00Z",
            "entry": entry
        }))
        .unwrap();

        assert_eq!(result["srsAlgorithm"], "sm2");
        assert_eq!(result["repetition"], expected_repetition);
        assert_eq!(result["interval"], expected_interval);
        assert_eq!(result["efactor"], expected_efactor);
        assert_eq!(result["nextDate"], expected_date);
    }
}

#[test]
fn fsrs_review_uses_exact_first_review_schedule() {
    let result = review(json!({
        "quality": 4,
        "algorithm": "fsrs",
        "today": "2026-06-16",
        "now": "2026-06-16T12:00:00Z",
        "entry": {}
    }))
    .unwrap();

    assert_eq!(result["srsAlgorithm"], "fsrs");
    assert_eq!(result["repetition"], 1);
    assert_eq!(result["interval"], 4);
    assert_eq!(result["stability"], 4.0);
    assert_eq!(result["difficulty"], 4.85);
    assert_eq!(result["nextDate"], "2026-06-20");
    assert_eq!(result["lastReviewedAt"], "2026-06-16T12:00:00Z");
}

#[test]
fn fsrs_review_uses_exact_later_review_schedule() {
    let result = review(json!({
        "quality": 3,
        "algorithm": "fsrs",
        "today": "2026-06-16",
        "now": "2026-06-16T12:00:00Z",
        "entry": {
            "repetition": 2,
            "interval": 7,
            "stability": 4.0,
            "difficulty": 5.0,
            "lastReviewedAt": "2026-06-12T12:00:00Z"
        }
    }))
    .unwrap();

    assert_eq!(result["srsAlgorithm"], "fsrs");
    assert_eq!(result["repetition"], 3);
    assert_eq!(result["interval"], 6);
    assert_eq!(result["stability"], 6.4);
    assert_eq!(result["difficulty"], 5.45);
    assert_eq!(result["nextDate"], "2026-06-22");
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
