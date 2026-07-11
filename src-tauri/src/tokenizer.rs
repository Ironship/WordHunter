use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Token {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

const STRIP_PUNCTUATION: &str =
    "\u{201e}\u{201c}\u{201d}\"\u{2018}\u{2019}.,!?;:()[]{}<>\u{00ab}\u{00bb}";

static CLASSIC_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*").expect("classic word pattern compiles")
});

static IMAGE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[IMG:[^\]]+\]").expect("image pattern compiles"));

static GUTENBERG_START: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*\* START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n")
        .expect("gutenberg start pattern compiles")
});

static GUTENBERG_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*\* END OF (THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*")
        .expect("gutenberg end pattern compiles")
});

static BLANK_LINES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("blank line pattern compiles"));

pub fn resolve_algorithm(value: Option<&str>) -> &'static str {
    match value {
        Some("classic") => "classic",
        _ => "modern",
    }
}

pub fn tokenize(text: &str, lang: &str, algorithm: Option<&str>) -> Vec<Token> {
    if text.is_empty() {
        return Vec::new();
    }
    let mode = resolve_algorithm(algorithm);
    let mut parts: Vec<Token> = Vec::new();
    let mut last = 0usize;

    for image_match in IMAGE_PATTERN.find_iter(text) {
        let start = image_match.start();
        let end = image_match.end();
        if start > last {
            push_text_block(&text[last..start], lang, mode, &mut parts);
        }
        let raw = &text[start..end];
        let inner = raw
            .strip_prefix("[IMG:")
            .and_then(|s| s.strip_suffix("]"))
            .unwrap_or(raw);
        parts.push(Token {
            kind: "image".to_string(),
            value: inner.to_string(),
        });
        last = end;
    }
    if last < text.len() {
        push_text_block(&text[last..], lang, mode, &mut parts);
    }

    merge_adjacent_text(&mut parts);
    parts
}

/// Visits the same word tokens as `tokenize` without allocating text/image tokens.
pub fn for_each_word(text: &str, lang: &str, algorithm: Option<&str>, mut visit: impl FnMut(&str)) {
    if text.is_empty() {
        return;
    }
    let mode = resolve_algorithm(algorithm);
    let mut last = 0usize;
    for image_match in IMAGE_PATTERN.find_iter(text) {
        if image_match.start() > last {
            visit_words_in_block(&text[last..image_match.start()], lang, mode, &mut visit);
        }
        last = image_match.end();
    }
    if last < text.len() {
        visit_words_in_block(&text[last..], lang, mode, &mut visit);
    }
}

fn visit_words_in_block(block: &str, _lang: &str, mode: &str, visit: &mut impl FnMut(&str)) {
    if mode == "classic" {
        for word in CLASSIC_PATTERN.find_iter(block) {
            visit(word.as_str());
        }
        return;
    }
    for segment in block.split_word_bounds() {
        if !segment.trim().is_empty()
            && segment
                .chars()
                .any(|c| c.is_alphabetic() || c.is_alphanumeric())
        {
            visit(segment);
        }
    }
}

fn push_text_block(block: &str, lang: &str, mode: &str, parts: &mut Vec<Token>) {
    if block.is_empty() {
        return;
    }
    if mode == "classic" {
        push_classic(block, parts);
    } else {
        push_modern(block, lang, parts);
    }
}

fn push_classic(block: &str, parts: &mut Vec<Token>) {
    let mut last = 0usize;
    for mat in CLASSIC_PATTERN.find_iter(block) {
        if mat.start() > last {
            parts.push(Token {
                kind: "text".to_string(),
                value: block[last..mat.start()].to_string(),
            });
        }
        parts.push(Token {
            kind: "word".to_string(),
            value: mat.as_str().to_string(),
        });
        last = mat.end();
    }
    if last < block.len() {
        parts.push(Token {
            kind: "text".to_string(),
            value: block[last..].to_string(),
        });
    }
}

fn push_modern(block: &str, _lang: &str, parts: &mut Vec<Token>) {
    for segment in block.split_word_bounds() {
        if segment.trim().is_empty() {
            continue;
        }
        let is_word = segment
            .chars()
            .any(|c| c.is_alphabetic() || c.is_alphanumeric());
        parts.push(Token {
            kind: if is_word { "word" } else { "text" }.to_string(),
            value: segment.to_string(),
        });
    }
}

fn merge_adjacent_text(parts: &mut Vec<Token>) {
    let mut merged: Vec<Token> = Vec::with_capacity(parts.len());
    for part in parts.drain(..) {
        if let Some(last) = merged.last_mut()
            && last.kind == "text"
            && part.kind == "text"
        {
            last.value.push_str(&part.value);
            continue;
        }
        merged.push(part);
    }
    *parts = merged;
}

pub fn normalize_word(value: &str) -> String {
    let stripped: String = value
        .to_lowercase()
        .chars()
        .filter(|c| !STRIP_PUNCTUATION.contains(*c))
        .collect();
    stripped.trim().to_string()
}

pub fn normalize_search_variants(value: &str) -> Vec<String> {
    let raw = normalize_word(value);
    let german: String = raw
        .replace('\u{00e4}', "ae")
        .replace('\u{00f6}', "oe")
        .replace('\u{00fc}', "ue")
        .replace('\u{00df}', "ss");
    let ascii: String = raw.nfd().filter(|c| !is_combining_mark(*c)).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for variant in [raw, german, ascii] {
        if !variant.is_empty() && seen.insert(variant.clone()) {
            out.push(variant);
        }
    }
    out
}

fn is_combining_mark(c: char) -> bool {
    let cp = c as u32;
    (0x0300..=0x036F).contains(&cp)
}

pub fn clean_gutenberg_text(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let after_start = GUTENBERG_START
        .find(&normalized)
        .map(|m| m.end())
        .unwrap_or(0);
    let after_end = GUTENBERG_END
        .find(&normalized)
        .map(|m| m.start())
        .unwrap_or(normalized.len());
    let (start, end) = if after_start >= after_end {
        (0, normalized.len())
    } else {
        (after_start, after_end)
    };
    let body = &normalized[start..end];
    BLANK_LINES.replace_all(body, "\n\n").trim().to_string()
}

pub fn text_stats(text: &str, vocab: &Value, lang: &str, algorithm: Option<&str>) -> Value {
    let mut words = std::collections::HashMap::new();
    for_each_word(text, lang, algorithm, |word| {
        let normalized = normalize_word(word);
        if !normalized.is_empty() {
            *words.entry(normalized).or_insert(0usize) += 1;
        }
    });
    let mut stats = serde_json::Map::new();
    stats.insert("unique".to_string(), json!(words.len()));
    stats.insert("known".to_string(), json!(0));
    stats.insert("learning".to_string(), json!(0));
    stats.insert("ignored".to_string(), json!(0));
    stats.insert("new".to_string(), json!(0));
    let vocab_obj = vocab.as_object();
    for (word, freq) in &words {
        let status = vocab_obj
            .and_then(|v| v.get(word))
            .and_then(|entry| entry.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("new");
        if let Some(count) = stats.get_mut(status)
            && let Some(n) = count.as_i64()
        {
            *count = json!(n + *freq as i64);
        } else {
            stats.insert(status.to_string(), json!(*freq as i64));
        }
    }
    Value::Object(stats)
}

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    match op {
        "tokenize" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            let lang = payload.get("lang").and_then(Value::as_str).unwrap_or("en");
            let algorithm = payload.get("algorithm").and_then(Value::as_str);
            Ok(json!({ "tokens": tokenize(text, lang, algorithm) }))
        }
        "normalize" => {
            let value = payload.get("value").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "normalized": normalize_word(value) }))
        }
        "search_variants" => {
            let value = payload.get("value").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "variants": normalize_search_variants(value) }))
        }
        "stats" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            let lang = payload.get("lang").and_then(Value::as_str).unwrap_or("en");
            let algorithm = payload.get("algorithm").and_then(Value::as_str);
            let vocab = payload.get("vocab").cloned().unwrap_or(Value::Null);
            Ok(text_stats(text, &vocab, lang, algorithm))
        }
        "clean_gutenberg" => {
            let raw = payload.get("raw").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "text": clean_gutenberg_text(raw) }))
        }
        other => Err(format!("unknown tokenizer op: {other}")),
    }
}

#[cfg(test)]
#[path = "tests/tokenizer/tests.rs"]
mod tests;
