use std::collections::{BTreeSet, HashMap, VecDeque};

use crate::tokenizer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabIndex {
    pub words: Vec<String>,
    pub frequencies: Vec<usize>,
    pub token_line: String,
}

#[derive(Default)]
struct PhraseNode<'a> {
    children: HashMap<&'a str, PhraseNode<'a>>,
    phrase: Option<&'a str>,
}

pub fn build_vocab_index(
    text: &str,
    lang: &str,
    algorithm: &str,
    phrase_candidates: &[String],
) -> VocabIndex {
    let mut word_positions: HashMap<String, usize> = HashMap::new();
    let mut words: Vec<String> = Vec::new();
    let mut frequencies = Vec::new();
    let mut phrase_trie = PhraseNode::default();
    let mut max_phrase_len = 0;
    for phrase in phrase_candidates {
        let parts = phrase.split_whitespace().collect::<Vec<_>>();
        if parts.len() > 1 {
            max_phrase_len = max_phrase_len.max(parts.len());
            let mut node = &mut phrase_trie;
            for part in parts.into_iter().rev() {
                node = node.children.entry(part).or_default();
            }
            node.phrase = Some(phrase);
        }
    }
    let mut recent_words = VecDeque::with_capacity(max_phrase_len);
    let mut found_phrases = BTreeSet::new();

    tokenizer::for_each_token(text, lang, Some(algorithm), |kind, value| {
        if kind != tokenizer::TokenKind::Word {
            if kind == tokenizer::TokenKind::Image
                || value.chars().any(|value| {
                    matches!(
                        value,
                        '.' | '!' | '?' | ';' | ',' | '\n' | '\r' | '。' | '！' | '？'
                    )
                })
            {
                recent_words.clear();
            }
            return;
        }
        let normalized = tokenizer::vocabulary_word_key(value, lang);
        if normalized.is_empty() {
            return;
        }
        if let Some(&index) = word_positions.get(&normalized) {
            frequencies[index] += 1;
        } else {
            word_positions.insert(normalized.clone(), words.len());
            words.push(normalized.clone());
            frequencies.push(1);
        }
        if max_phrase_len == 0 {
            return;
        }
        recent_words.push_back(normalized);
        if recent_words.len() > max_phrase_len {
            recent_words.pop_front();
        }
        let mut node = &phrase_trie;
        for word in recent_words.iter().rev() {
            let Some(next) = node.children.get(word.as_str()) else {
                break;
            };
            node = next;
            if let Some(phrase) = node.phrase {
                found_phrases.insert(phrase.to_string());
            }
        }
    });

    // Double spaces keep independent phrases from producing cross-boundary matches.
    let mut token_line = String::from(" ");
    let mut first = true;
    for phrase in found_phrases {
        if !first {
            token_line.push(' ');
        }
        token_line.push_str(&phrase);
        token_line.push(' ');
        first = false;
    }
    if first {
        token_line.push(' ');
    }
    VocabIndex {
        words,
        frequencies,
        token_line,
    }
}
