use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

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

pub fn resolve_algorithm(value: Option<&str>) -> &'static str {
    match value {
        Some("classic") => "classic",
        _ => "modern",
    }
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
    .replace(['‘', '’'], "'");
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
#[cfg(test)]
#[path = "tests/tokenizer/tests.rs"]
mod tests;
