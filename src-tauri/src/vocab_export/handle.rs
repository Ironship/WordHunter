use serde_json::{Value, json};

use super::filter;
use super::tsv;

const VALID_STATUSES: &[&str] = &["new", "learning", "known", "ignored"];

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    match op {
        "query" => query(payload),
        "export" => export(payload),
        "import" => import(payload),
        other => Err(format!("unknown vocab_export op: {other}")),
    }
}

fn read_statuses(payload: &Value) -> Vec<String> {
    payload
        .get("statuses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| VALID_STATUSES.contains(s))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_else(|| VALID_STATUSES.iter().map(|s| s.to_string()).collect())
}

fn read_filter_opts<'a>(payload: &'a Value, statuses: &'a [String]) -> filter::FilterOptions<'a> {
    let vocab = payload.get("vocab").unwrap_or(&Value::Null);
    let query = payload.get("query").and_then(Value::as_str).unwrap_or("");
    let text_index = payload.get("textIndex");
    let lang = payload.get("lang").and_then(Value::as_str).unwrap_or("en");
    filter::FilterOptions {
        vocab,
        query,
        statuses,
        text_index,
        lang,
    }
}

fn query(payload: Value) -> Result<Value, String> {
    let statuses = read_statuses(&payload);
    let entries = filter::filter_entries(read_filter_opts(&payload, &statuses));
    Ok(json!({ "entries": entries }))
}

fn export(payload: Value) -> Result<Value, String> {
    let format = payload
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("txt");
    let statuses = read_statuses(&payload);
    let entries = filter::filter_entries(read_filter_opts(&payload, &statuses));
    let header = payload.get("headerRow").and_then(Value::as_str);
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("export.txt");

    let (content, mime, ext) = match format {
        "anki" => (
            tsv::to_anki_tsv(&entries, header),
            "text/tab-separated-values",
            "tsv",
        ),
        "txt" => (
            tsv::to_words_txt(&entries),
            "text/plain;charset=utf-8",
            "txt",
        ),
        other => return Err(format!("unknown export format: {other}")),
    };

    let final_filename = if filename.to_lowercase().ends_with(&format!(".{ext}")) {
        filename.to_string()
    } else {
        format!("{filename}.{ext}")
    };

    Ok(json!({
        "filename": final_filename,
        "mime": mime,
        "content": content,
        "count": entries.len(),
    }))
}

fn import(payload: Value) -> Result<Value, String> {
    let tsv_input = payload
        .get("tsv")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing tsv".to_string())?;
    let result = tsv::parse_anki_tsv(tsv_input);
    let rows: Vec<Value> = result
        .rows
        .iter()
        .map(|r| {
            json!({
                "word": r.word,
                "translation": r.translation,
                "context": r.context,
                "article": r.article,
            })
        })
        .collect();
    Ok(json!({
        "headerFound": result.header_found,
        "rows": rows,
    }))
}
