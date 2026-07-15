use std::collections::HashMap;

use serde_json::Value;

use super::cache_key::status_from_vocab;
use crate::tokenizer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VocabStats {
    pub unique: usize,
    pub known: usize,
    pub learning: usize,
    pub ignored: usize,
    pub new: usize,
}

impl VocabStats {
    pub fn from_words(words: &[String], frequencies: &[usize], vocab: &Value, lang: &str) -> Self {
        let mut known = 0usize;
        let mut learning = 0usize;
        let mut ignored = 0usize;
        let mut new = 0usize;
        let mut statuses: HashMap<String, &str> = HashMap::new();
        if let Some(entries) = vocab.as_object() {
            for word in entries.keys() {
                statuses
                    .entry(tokenizer::vocabulary_word_key(word, lang))
                    .or_insert_with(|| status_from_vocab(vocab, word));
            }
            for word in entries.keys() {
                let canonical = tokenizer::vocabulary_word_key(word, lang);
                if tokenizer::normalize_word(word) == canonical {
                    statuses.insert(canonical, status_from_vocab(vocab, word));
                }
            }
        }
        for (word, &freq) in words.iter().zip(frequencies.iter()) {
            match statuses.get(word).copied().unwrap_or("new") {
                "known" => known += freq,
                "learning" => learning += freq,
                "ignored" => ignored += freq,
                _ => new += freq,
            }
        }
        VocabStats {
            unique: words.len(),
            known,
            learning,
            ignored,
            new,
        }
    }
}
