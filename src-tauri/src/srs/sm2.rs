use serde_json::{Value, json};

use super::{finite_f64, finite_i64, normalize_quality, round_to};

pub(crate) fn calculate_sm2(quality: f64, prev: &Value) -> Value {
    let q = normalize_quality(quality);
    let repetition = finite_i64(prev, "repetition").unwrap_or(0);
    let interval = finite_i64(prev, "interval").unwrap_or(0);
    let efactor = finite_f64(prev, "efactor").unwrap_or(2.5);

    let (next_repetition, next_interval) = if q >= 3 {
        let next_interval = if repetition == 0 {
            1
        } else if repetition == 1 {
            6
        } else {
            (interval as f64 * efactor).round() as i64
        };
        (repetition + 1, next_interval)
    } else {
        (0, 1)
    };

    let qf = q as f64;
    let mut next_efactor = efactor + (0.1 - (5.0 - qf) * (0.08 + (5.0 - qf) * 0.02));
    if next_efactor < 1.3 {
        next_efactor = 1.3;
    }

    json!({
        "repetition": next_repetition,
        "interval": next_interval,
        "efactor": round_to(next_efactor, 4)
    })
}
