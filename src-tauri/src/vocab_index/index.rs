use std::collections::HashMap;

use crate::tokenizer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabIndex {
    pub words: Vec<String>,
    pub frequencies: Vec<usize>,
    pub token_line: String,
}

pub fn build_vocab_index(text: &str, lang: &str, algorithm: &str) -> VocabIndex {
    let mut word_freq: HashMap<String, usize> = HashMap::new();
    let mut words: Vec<String> = Vec::new();

    for token in tokenizer::tokenize(text, lang, Some(algorithm)) {
        if token.kind != "word" {
            continue;
        }
        let normalized = tokenizer::normalize_word(&token.value);
        if normalized.is_empty() {
            continue;
        }
        let count = word_freq.entry(normalized.clone()).or_insert(0);
        if *count == 0 {
            words.push(normalized);
        }
        *count += 1;
    }

    let frequencies: Vec<usize> = words.iter().map(|w| *word_freq.get(w).unwrap()).collect();
    let token_line = format!(" {} ", words.join(" "));
    VocabIndex {
        words,
        frequencies,
        token_line,
    }
}
