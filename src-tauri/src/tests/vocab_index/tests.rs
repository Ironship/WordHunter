use serde_json::{Value, json};

use crate::vocab_index;

fn book_payload() -> Value {
    json!({
        "id": "en-foo",
        "updatedAt": "2024-01-02",
        "createdAt": "2024-01-01",
        "textUrl": "https://example.com/foo.txt",
        "localPath": "/tmp/foo.txt"
    })
}

#[test]
fn handle_rejects_missing_text() {
    let payload = json!({});
    let err = vocab_index::handle(payload).expect_err("should reject");
    assert!(err.contains("text"), "unexpected error: {err}");
}

#[test]
fn handle_returns_words_stats() {
    let payload = json!({
        "text": "Hello world. Hello Rust!",
        "vocab": {
            "hello": { "status": "known" },
            "world": { "status": "learning" }
        },
        "lang": "en",
        "algorithm": "modern",
        "book": book_payload(),
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    assert_eq!(result["unique"], 3);
    assert_eq!(result["known"], 2);
    assert_eq!(result["learning"], 1);
    assert_eq!(result["new"], 1);
    let words: Vec<String> = result["words"]
        .as_array()
        .expect("words is array")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(words, vec!["hello", "world", "rust"]);
    assert_eq!(result["tokenLine"].as_str().unwrap(), " hello world rust ");
    assert!(result.get("signature").is_none());
}

#[test]
fn handle_uses_default_lang_and_algorithm() {
    let payload = json!({
        "text": "alpha beta alpha",
        "vocab": {},
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    assert_eq!(result["unique"], 2);
}

#[test]
fn handle_counts_ignored_status() {
    let payload = json!({
        "text": "alpha beta gamma",
        "vocab": {
            "alpha": { "status": "ignored" },
            "beta": { "status": "ignored" }
        },
        "lang": "en",
        "algorithm": "modern",
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    assert_eq!(result["unique"], 3);
    assert_eq!(result["ignored"], 2);
    assert_eq!(result["new"], 1);
}

#[test]
fn handle_falls_back_to_new_for_unknown_status() {
    let payload = json!({
        "text": "alpha",
        "vocab": { "alpha": { "status": "weird" } },
        "lang": "en",
        "algorithm": "modern",
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    assert_eq!(result["new"], 1);
    assert_eq!(result["known"], 0);
}

#[test]
fn handle_classic_keeps_hyphenated_words() {
    let modern = json!({
        "text": "well-known don't stop",
        "lang": "en",
        "algorithm": "modern",
        "vocab": {},
    });
    let classic = json!({
        "text": "well-known don't stop",
        "lang": "en",
        "algorithm": "classic",
        "vocab": {},
    });
    let modern_result = vocab_index::handle(modern).expect("modern");
    let classic_result = vocab_index::handle(classic).expect("classic");
    let modern_words: Vec<String> = modern_result["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let classic_words: Vec<String> = classic_result["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(classic_words, vec!["well-known", "don't", "stop"]);
    assert!(modern_words.contains(&"well".to_string()));
    assert!(modern_words.contains(&"known".to_string()));
    assert!(modern_words.len() > classic_words.len());
}

#[test]
fn handle_handles_empty_text() {
    let payload = json!({
        "text": "",
        "vocab": {},
        "lang": "en",
        "algorithm": "modern",
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    assert_eq!(result["unique"], 0);
    assert_eq!(result["known"], 0);
    assert_eq!(result["learning"], 0);
    assert_eq!(result["ignored"], 0);
    assert_eq!(result["new"], 0);
    assert_eq!(result["words"].as_array().unwrap().len(), 0);
    assert_eq!(result["tokenLine"].as_str().unwrap(), "  ");
}

#[test]
fn handle_token_line_supports_phrase_lookup() {
    let payload = json!({
        "text": "The quick brown fox jumps.",
        "vocab": {},
        "lang": "en",
        "algorithm": "modern",
    });
    let result = vocab_index::handle(payload).expect("handle succeeds");
    let token_line = result["tokenLine"].as_str().unwrap();
    assert!(token_line.contains(" quick brown fox "));
}
