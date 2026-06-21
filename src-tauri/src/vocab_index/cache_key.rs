use serde_json::Value;

use crate::tokenizer;

use super::hash;

const SIGNATURE_VERSION: &str = "v2";
const VALID_STATUSES: &[&str] = &["new", "learning", "known", "ignored"];

pub fn text_signature(book: Option<&Value>, text: &str, lang: &str, algorithm: &str) -> String {
    let id = book_field(book, "id");
    let updated = book_field(book, "updatedAt");
    let created = book_field(book, "createdAt");
    let text_url = book_field(book, "textUrl");
    let local_path = book_field(book, "localPath");
    let text_hash = hash::fnv1a_hash_base36(&hash::sample_text(text));
    format!(
        "{SIGNATURE_VERSION}|{id}|{lang}|{algorithm}|{updated}|{created}|{text_url}|{local_path}|{len}|{text_hash}",
        len = text.len(),
    )
}

fn book_field<'a>(book: Option<&'a Value>, key: &str) -> &'a str {
    book.and_then(|b| b.get(key)).and_then(Value::as_str).unwrap_or("")
}

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
