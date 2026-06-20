use serde_json::{json, Value};

use super::date::elapsed_days_since;
use super::{finite_f64, finite_i64, normalize_quality, round_to};

pub(crate) fn calculate_fsrs(quality: f64, prev: &Value, now_iso: &str) -> Value {
    let rating = fsrs_rating(quality);
    let repetition = finite_i64(prev, "repetition").unwrap_or(0);
    let interval = finite_f64(prev, "interval").unwrap_or(0.0);
    let stability = finite_f64(prev, "stability")
        .filter(|value| *value > 0.0)
        .unwrap_or_else(|| interval.max(0.0))
        .max(0.1);
    let difficulty = finite_f64(prev, "difficulty")
        .unwrap_or(5.0)
        .clamp(1.0, 10.0);
    let elapsed = elapsed_days_since(prev.get("lastReviewedAt").and_then(Value::as_str), now_iso);
    let retrievability = (1.0 + elapsed as f64 / (9.0 * stability)).powf(-1.0);
    let is_first_review = prev.get("lastReviewedAt").and_then(Value::as_str).is_none()
        && finite_f64(prev, "stability")
            .map(|value| value <= 0.0)
            .unwrap_or(true);

    let mut next_stability = if is_first_review {
        match rating {
            "again" => 1.0,
            "hard" => 2.0,
            "good" => 4.0,
            _ => 7.0,
        }
    } else if rating == "again" {
        (stability * (0.45 + 0.2 * retrievability)).max(1.0)
    } else {
        let rating_boost = match rating {
            "hard" => 1.2,
            "good" => 2.25,
            _ => 3.4,
        };
        let difficulty_boost = 1.0 + (10.0 - difficulty) / 12.0;
        let overdue_boost = 1.0 + (1.0 - retrievability) * 1.4;
        stability * rating_boost * difficulty_boost * overdue_boost
    };
    if rating == "hard" && !is_first_review {
        next_stability = next_stability.min(stability * 1.6);
    }

    let difficulty_delta = match rating {
        "again" => 1.15,
        "hard" => 0.45,
        "good" => -0.15,
        _ => -0.65,
    };
    let next_difficulty = (difficulty + difficulty_delta).clamp(1.0, 10.0);
    let next_interval = if rating == "again" {
        1
    } else {
        next_stability.round().max(1.0) as i64
    };

    json!({
        "repetition": if rating == "again" { 0 } else { repetition + 1 },
        "interval": next_interval,
        "stability": round_to(next_stability, 2),
        "difficulty": round_to(next_difficulty, 2)
    })
}

fn fsrs_rating(quality: f64) -> &'static str {
    match normalize_quality(quality) {
        0..=2 => "again",
        3 => "hard",
        4 => "good",
        _ => "easy",
    }
}
