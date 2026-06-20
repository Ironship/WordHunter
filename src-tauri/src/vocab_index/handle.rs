use serde_json::{json, Value};

use super::cache_key;
use super::index;
use super::stats;

pub fn handle(payload: Value) -> Result<Value, String> {
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing text".to_string())?;
    let vocab = payload.get("vocab").cloned().unwrap_or(Value::Null);
    let lang = payload
        .get("lang")
        .and_then(Value::as_str)
        .unwrap_or("en");
    let algorithm = payload
        .get("algorithm")
        .and_then(Value::as_str);
    let book = payload.get("book");

    let algorithm = cache_key::algorithm_name(algorithm);
    let index = index::build_vocab_index(text, lang, algorithm);
    let stats = stats::VocabStats::from_words(&index.words, &vocab);
    let signature = cache_key::text_signature(book, text, lang, algorithm);

    Ok(json!({
        "unique": stats.unique,
        "known": stats.known,
        "learning": stats.learning,
        "ignored": stats.ignored,
        "new": stats.new,
        "signature": signature,
        "words": index.words,
        "tokenLine": index.token_line,
    }))
}
