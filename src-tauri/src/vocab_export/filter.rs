use std::collections::HashSet;

use serde_json::Value;

use crate::tokenizer;

pub struct FilterOptions<'a> {
    pub vocab: &'a Value,
    pub query: &'a str,
    pub statuses: &'a [String],
    pub text_index: Option<&'a Value>,
}

pub fn filter_entries(opts: FilterOptions<'_>) -> Vec<Value> {
    let query_variants = tokenizer::normalize_search_variants(opts.query);
    let status_set: HashSet<&str> = opts.statuses.iter().map(String::as_str).collect();

    let text_words: Option<HashSet<String>> = opts
        .text_index
        .and_then(|ti| ti.get("words"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        });
    let token_line: Option<&str> = opts
        .text_index
        .and_then(|ti| ti.get("tokenLine"))
        .and_then(Value::as_str);

    let mut entries: Vec<Value> = Vec::new();
    if let Some(obj) = opts.vocab.as_object() {
        for (word, entry) in obj {
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("new");
            if !status_set.contains(status) {
                continue;
            }

            if !entry_matches_query(word, entry, &query_variants) {
                continue;
            }

            if !entry_in_text(word, &text_words, token_line.unwrap_or("")) {
                continue;
            }

            let mut merged = entry.as_object().cloned().unwrap_or_default();
            merged.insert("word".to_string(), Value::String(word.clone()));
            entries.push(Value::Object(merged));
        }
    }

    entries.sort_by(|a, b| {
        let aw = a
            .get("word")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let bw = b
            .get("word")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        aw.cmp(&bw)
    });

    entries
}

fn entry_matches_query(word: &str, entry: &Value, query_variants: &[String]) -> bool {
    if query_variants.is_empty() {
        return true;
    }
    let translation = entry
        .get("translation")
        .and_then(Value::as_str)
        .unwrap_or("");
    let note = entry.get("note").and_then(Value::as_str).unwrap_or("");
    let haystack = format!("{word} {translation} {note}");
    let haystack_variants = tokenizer::normalize_search_variants(&haystack);
    query_variants
        .iter()
        .any(|q| haystack_variants.iter().any(|h| h.contains(q.as_str())))
}

fn entry_in_text(
    word: &str,
    text_words: &Option<HashSet<String>>,
    token_line: &str,
) -> bool {
    let Some(words) = text_words else {
        return true;
    };
    let normalized = tokenizer::normalize_word(word);
    if normalized.is_empty() {
        return false;
    }
    if !normalized.contains(' ') {
        return words.contains(&normalized);
    }
    let phrase = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    !phrase.is_empty() && token_line.contains(&format!(" {phrase} "))
}
