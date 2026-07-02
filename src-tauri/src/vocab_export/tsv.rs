use serde_json::Value;

const DEFAULT_ANKI_HEADER: &str = "word\ttranslation\tcontext\n";

pub struct AnkiRow {
    pub word: String,
    pub translation: String,
    pub context: String,
}

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
        out.push_str(&format!("{word}\t{translation}\t{context}\n"));
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
        out.push_str(&word);
        out.push('\n');
    }
    out
}

pub fn parse_anki_tsv(tsv: &str) -> AnkiParseResult {
    let mut rows = Vec::new();
    let mut header_found = false;
    for raw_line in tsv.split('\n') {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        let first = parts.first().copied().unwrap_or("").trim();
        if !header_found && first.eq_ignore_ascii_case("word") {
            header_found = true;
            continue;
        }
        let word = parts.get(0).copied().unwrap_or("").trim().to_string();
        if word.is_empty() {
            continue;
        }
        let translation = parts.get(1).copied().unwrap_or("").trim().to_string();
        let context = parts.get(2).copied().unwrap_or("").trim().to_string();
        rows.push(AnkiRow {
            word,
            translation,
            context,
        });
    }
    AnkiParseResult { header_found, rows }
}
