use serde_json::{Value, json};

use super::cache_key;
use super::index;
use super::stats;
use crate::tokenizer;

fn phrase_candidates(vocab: &Value, lang: &str) -> Vec<String> {
    let Some(entries) = vocab.as_object() else {
        return Vec::new();
    };
    let mut phrases = std::collections::BTreeSet::new();
    for (key, entry) in entries {
        for value in [
            Some(key.as_str()),
            entry.get("word").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        {
            let mut phrase = String::new();
            let mut word_count = 0;
            for part in value.split_whitespace() {
                let part = tokenizer::vocabulary_word_key(part, lang);
                if part.is_empty() {
                    continue;
                }
                if word_count > 0 {
                    phrase.push(' ');
                }
                phrase.push_str(&part);
                word_count += 1;
            }
            if word_count > 1 {
                phrases.insert(phrase);
            }
        }
    }
    phrases.into_iter().collect()
}

pub fn handle(mut payload: Value) -> Result<Value, String> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "payload must be an object".to_string())?;
    let text = object
        .remove("text")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "missing text".to_string())?;
    let vocab = object.remove("vocab").unwrap_or(Value::Null);
    let lang = object
        .remove("lang")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "en".to_string());
    let algorithm = object
        .remove("algorithm")
        .and_then(|value| value.as_str().map(str::to_owned));

    let algorithm = cache_key::algorithm_name(algorithm.as_deref());
    let phrases = phrase_candidates(&vocab, &lang);
    let index = index::build_vocab_index(&text, &lang, algorithm, &phrases);
    let stats = stats::VocabStats::from_words(&index.words, &index.frequencies, &vocab, &lang);

    Ok(json!({
        "indexVersion": 4,
        "unique": stats.unique,
        "known": stats.known,
        "learning": stats.learning,
        "ignored": stats.ignored,
        "new": stats.new,
        "words": index.words,
        "tokenLine": index.token_line,
    }))
}
