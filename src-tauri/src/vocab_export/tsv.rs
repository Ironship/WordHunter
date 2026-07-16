use serde_json::Value;

const DEFAULT_ANKI_HEADER: &str = "word\ttranslation\tcontext\tarticle\n";

pub struct AnkiRow {
    pub word: String,
    pub translation: String,
    pub context: String,
    pub article: String,
}

const LOCALIZED_ANKI_WORD_HEADERS: &[&str] = &[
    "word",
    "słowo",
    "wort",
    "palabra",
    "mot",
    "parola",
    "単語",
    "слово",
];
const LOCALIZED_ANKI_TRANSLATION_HEADERS: &[&str] = &[
    "translation",
    "tłumaczenie",
    "übersetzung",
    "traducción",
    "traduction",
    "traduzione",
    "翻訳",
    "перевод",
    "переклад",
];
const LOCALIZED_ANKI_CONTEXT_HEADERS: &[&str] = &[
    "context",
    "kontekst",
    "kontext",
    "contexto",
    "contexte",
    "contesto",
    "文脈",
    "контекст",
];

pub struct AnkiParseResult {
    pub header_found: bool,
    pub rows: Vec<AnkiRow>,
}

pub fn clean_cell(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c == '\t' || c == '\r' || c == '\n' {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn entry_context(entry: &Value) -> String {
    let from_examples = entry
        .get("examples")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(Value::as_str);
    let raw =
        from_examples.unwrap_or_else(|| entry.get("note").and_then(Value::as_str).unwrap_or(""));
    clean_cell(raw)
}

pub fn to_anki_tsv(entries: &[Value], header: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(header.unwrap_or(DEFAULT_ANKI_HEADER));
    for entry in entries {
        let word = clean_cell(entry.get("word").and_then(Value::as_str).unwrap_or(""));
        let translation = clean_cell(
            entry
                .get("translation")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let context = entry_context(entry);
        let article = clean_cell(entry.get("article").and_then(Value::as_str).unwrap_or(""));
        out.push_str(&format!("{word}\t{translation}\t{context}\t{article}\n"));
    }
    out
}

pub fn to_words_txt(entries: &[Value]) -> String {
    let mut out = String::new();
    for entry in entries {
        let word = clean_cell(entry.get("word").and_then(Value::as_str).unwrap_or(""));
        if word.is_empty() {
            continue;
        }
        let article = clean_cell(entry.get("article").and_then(Value::as_str).unwrap_or(""));
        out.push_str(&format_headword(&word, &article));
        out.push('\n');
    }
    out
}

fn format_headword(word: &str, article: &str) -> String {
    if article.is_empty() {
        return word.to_string();
    }
    let comparable_word = word.trim().to_lowercase().replace('’', "'");
    let comparable_article = article.trim().to_lowercase().replace('’', "'");
    let already_has_article = if comparable_article.ends_with('\'') {
        comparable_word.starts_with(&comparable_article)
    } else {
        comparable_word == comparable_article
            || comparable_word.starts_with(&format!("{comparable_article} "))
    };
    if already_has_article {
        return word.to_string();
    }
    if article.ends_with('\'') || article.ends_with('’') {
        format!("{article}{word}")
    } else {
        format!("{article} {word}")
    }
}

fn is_localized_anki_header(parts: &[&str]) -> bool {
    if parts.len() < 3 {
        return false;
    }
    let word = parts[0].trim().to_lowercase();
    let translation = parts[1].trim().to_lowercase();
    let context = parts[2].trim().to_lowercase();
    LOCALIZED_ANKI_WORD_HEADERS.contains(&word.as_str())
        && LOCALIZED_ANKI_TRANSLATION_HEADERS.contains(&translation.as_str())
        && LOCALIZED_ANKI_CONTEXT_HEADERS.contains(&context.as_str())
}

pub fn parse_anki_tsv(tsv: &str) -> AnkiParseResult {
    let mut rows = Vec::new();
    let mut header_found = false;
    let mut is_first_non_empty_line = true;
    for raw_line in tsv.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        let first = parts.first().copied().unwrap_or("").trim();
        if is_first_non_empty_line && is_localized_anki_header(&parts) {
            is_first_non_empty_line = false;
            header_found = true;
            continue;
        }
        is_first_non_empty_line = false;
        let word = first.to_string();
        if word.is_empty() {
            continue;
        }
        let translation = parts.get(1).copied().unwrap_or("").trim().to_string();
        let context = parts.get(2).copied().unwrap_or("").trim().to_string();
        let article = parts.get(3).copied().unwrap_or("").trim().to_string();
        rows.push(AnkiRow {
            word,
            translation,
            context,
            article,
        });
    }
    AnkiParseResult { header_found, rows }
}
