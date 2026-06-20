use serde_json::Value;

use super::cache_key::status_from_vocab;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VocabStats {
    pub unique: usize,
    pub known: usize,
    pub learning: usize,
    pub ignored: usize,
    pub new: usize,
}

impl VocabStats {
    pub fn from_words(words: &[String], vocab: &Value) -> Self {
        let mut known = 0usize;
        let mut learning = 0usize;
        let mut ignored = 0usize;
        let mut new = 0usize;
        for word in words {
            match status_from_vocab(vocab, word) {
                "known" => known += 1,
                "learning" => learning += 1,
                "ignored" => ignored += 1,
                _ => new += 1,
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
