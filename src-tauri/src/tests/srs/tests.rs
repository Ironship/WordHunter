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
fn review_rejects_out_of_range_quality_non_object_entries_and_unknown_algorithms() {
    assert!(review(json!({ "quality": 6, "entry": {} })).is_err());
    assert!(review(json!({ "quality": 3, "entry": "garbage" })).is_err());
    assert!(review(json!({ "quality": 3, "entry": {}, "algorithm": "bogus" })).is_err());
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
