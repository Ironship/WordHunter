use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Token {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Word,
    Text,
    Image,
}

const STRIP_PUNCTUATION: &str =
    "\u{201e}\u{201c}\u{201d}\"\u{2018}\u{2019}.,!?;:()[]{}<>\u{00ab}\u{00bb}";

static CLASSIC_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*").expect("classic word pattern compiles")
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
    let mut parts: Vec<Token> = Vec::new();
    for_each_token(text, lang, algorithm, |kind, value| {
        parts.push(Token {
            kind: match kind {
                TokenKind::Word => "word",
                TokenKind::Text => "text",
                TokenKind::Image => "image",
            }
            .to_string(),
            value: value.to_string(),
        });
    });
    merge_adjacent_text(&mut parts);
    parts
}

pub fn for_each_token(
    text: &str,
    _lang: &str,
    algorithm: Option<&str>,
    mut visit: impl FnMut(TokenKind, &str),
) {
    if text.is_empty() {
        return;
    }
    let mode = resolve_algorithm(algorithm);
    let mut last = 0usize;
    for image_match in IMAGE_PATTERN.find_iter(text) {
        if image_match.start() > last {
            visit_tokens_in_block(&text[last..image_match.start()], mode, &mut visit);
        }
        let raw = image_match.as_str();
        visit(
            TokenKind::Image,
            raw.strip_prefix("[IMG:")
                .and_then(|value| value.strip_suffix(']'))
                .unwrap_or(raw),
        );
        last = image_match.end();
    }
    if last < text.len() {
        visit_tokens_in_block(&text[last..], mode, &mut visit);
    }
}

/// Visits the same word tokens as `tokenize` without allocating text/image tokens.
pub fn for_each_word(text: &str, lang: &str, algorithm: Option<&str>, mut visit: impl FnMut(&str)) {
    for_each_token(text, lang, algorithm, |kind, value| {
        if kind == TokenKind::Word {
            visit(value);
        }
    });
}

fn visit_tokens_in_block(block: &str, mode: &str, visit: &mut impl FnMut(TokenKind, &str)) {
    if mode == "classic" {
        let mut last = 0;
        for word in CLASSIC_PATTERN.find_iter(block) {
            if word.start() > last {
                visit(TokenKind::Text, &block[last..word.start()]);
            }
            visit(TokenKind::Word, word.as_str());
            last = word.end();
        }
        if last < block.len() {
            visit(TokenKind::Text, &block[last..]);
        }
        return;
    }
    for segment in block.split_word_bounds() {
        visit(
            if segment.chars().any(char::is_alphanumeric) {
                TokenKind::Word
            } else {
                TokenKind::Text
            },
            segment,
        );
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
    let compatible: String = value.nfc().collect();
    let mut folded = String::new();
    for c in compatible.to_lowercase().chars() {
        match c {
            '‘' | '’' => folded.push('\''),
            _ => folded.push(c),
        }
    }
    let stripped: String = folded
        .chars()
        .filter(|c| !STRIP_PUNCTUATION.contains(*c))
        .collect();
    stripped.trim().nfc().collect()
}

fn case_fold_vocabulary_word(value: String) -> String {
    value.replace('ß', "ss").replace('ς', "σ")
}

pub fn vocabulary_word_key(value: &str, lang: &str) -> String {
    let primary = lang.split(['-', '_']).next().unwrap_or("");
    let language = if primary.bytes().all(|value| !value.is_ascii_uppercase()) {
        Cow::Borrowed(primary)
    } else {
        Cow::Owned(primary.to_lowercase())
    };
    let compatible: String = value.nfkc().collect();
    let locale_adjusted = if matches!(language.as_ref(), "tr" | "az") {
        compatible.replace('I', "ı").replace('İ', "i")
    } else {
        compatible
    }
    .replace('‘', "'")
    .replace('’', "'");
    let prefixes: &[(&str, &str)] = match language.as_ref() {
        "fr" => &[("l'", "l’")],
        "it" => &[("un'", "un’"), ("l'", "l’")],
        _ => &[],
    };
    let lowered = locale_adjusted.to_lowercase();
    for &(straight, curly) in prefixes {
        let remainder = lowered
            .strip_prefix(straight)
            .or_else(|| lowered.strip_prefix(curly));
        if let Some(remainder) = remainder {
            let word = normalize_word(remainder);
            if !word.is_empty() {
                return case_fold_vocabulary_word(word);
            }
        }
    }
    case_fold_vocabulary_word(normalize_word(&locale_adjusted))
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
        let normalized = vocabulary_word_key(word, lang);
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
    let mut canonical_vocab = std::collections::HashMap::new();
    if let Some(vocab_obj) = vocab_obj {
        for (word, entry) in vocab_obj {
            canonical_vocab
                .entry(vocabulary_word_key(word, lang))
                .or_insert(entry);
        }
        for (word, entry) in vocab_obj {
            let canonical = vocabulary_word_key(word, lang);
            if normalize_word(word) == canonical {
                canonical_vocab.insert(canonical, entry);
            }
        }
    }
    for (word, freq) in &words {
        let status = canonical_vocab
            .get(word)
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
