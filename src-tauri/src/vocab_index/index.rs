use std::collections::HashSet;

use crate::tokenizer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabIndex {
    pub words: Vec<String>,
    pub token_line: String,
}

pub fn build_vocab_index(text: &str, lang: &str, algorithm: &str) -> VocabIndex {
    let mut seen: HashSet<String> = HashSet::new();
    let mut words: Vec<String> = Vec::new();
    for token in tokenizer::tokenize(text, lang, Some(algorithm)) {
        if token.kind != "word" {
            continue;
        }
        let normalized = tokenizer::normalize_word(&token.value);
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        words.push(normalized);
    }
    let token_line = format!(" {} ", words.join(" "));
    VocabIndex { words, token_line }
}
