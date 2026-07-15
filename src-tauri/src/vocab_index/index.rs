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

    tokenizer::for_each_word(text, lang, Some(algorithm), |word| {
        let normalized = tokenizer::vocabulary_word_key(word, lang);
        if normalized.is_empty() {
            return;
        }
        let count = word_freq.entry(normalized.clone()).or_insert(0);
        if *count == 0 {
            words.push(normalized);
        }
        *count += 1;
    });

    let frequencies: Vec<usize> = words.iter().map(|w| *word_freq.get(w).unwrap()).collect();
    let token_line = format!(" {} ", words.join(" "));
    VocabIndex {
        words,
        frequencies,
        token_line,
    }
}
