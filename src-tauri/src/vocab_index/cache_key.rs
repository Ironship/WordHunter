use serde_json::Value;

use crate::tokenizer;

const VALID_STATUSES: &[&str] = &["new", "learning", "known", "ignored"];

pub fn algorithm_name(algorithm: Option<&str>) -> &'static str {
    tokenizer::resolve_algorithm(algorithm)
}

pub fn status_from_vocab<'a>(vocab: &'a Value, word: &str) -> &'a str {
    let raw = vocab
        .get(word)
        .and_then(|entry| entry.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("new");
    if VALID_STATUSES.contains(&raw) {
        raw
    } else {
        "new"
    }
}
