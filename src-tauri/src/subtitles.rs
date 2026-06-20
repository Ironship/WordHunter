use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

const ASS_OVERRIDE: &str = r"\{[^}]*\}";
const HTML_TAG: &str = r"</?[^>]+>";
const ASS_BREAK: &str = r"\\[Nnh]";
const BRACKETED: &str = r"\[[^\]]*\]";
const WHITESPACE: &str = r"\s+";

const SRT_TIMESTAMP: &str =
    r"\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}";
const VTT_TIMESTAMP: &str =
    r"(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}";
const SEQUENCE_NUMBER: &str = r"^\d+$";
const ASS_DIALOGUE: &str = r"^Dialogue:\s*(.+)$";
const ASS_FORMAT: &str = r"^Format:\s*(.+)$";
const ASS_EVENTS: &str = r"(?i)^\[events\]$";
const ASS_SECTION: &str = r"^\[.+\]$";
const ASS_VTT_HEADER: &str = r"(?i)^WEBVTT($|\s)";
const ASS_VTT_BLOCK_HEADER: &str = r"(?i)^(NOTE|STYLE|REGION)($|\s)";

static RE_ASS_OVERRIDE: Lazy<Regex> = Lazy::new(|| Regex::new(ASS_OVERRIDE).unwrap());
static RE_HTML_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(HTML_TAG).unwrap());
static RE_ASS_BREAK: Lazy<Regex> = Lazy::new(|| Regex::new(ASS_BREAK).unwrap());
static RE_BRACKETED: Lazy<Regex> = Lazy::new(|| Regex::new(BRACKETED).unwrap());
static RE_WHITESPACE: Lazy<Regex> = Lazy::new(|| Regex::new(WHITESPACE).unwrap());
static RE_SRT_TIMESTAMP: Lazy<Regex> = Lazy::new(|| Regex::new(SRT_TIMESTAMP).unwrap());
static RE_VTT_TIMESTAMP: Lazy<Regex> = Lazy::new(|| Regex::new(VTT_TIMESTAMP).unwrap());
static RE_SEQUENCE: Lazy<Regex> = Lazy::new(|| Regex::new(SEQUENCE_NUMBER).unwrap());
static RE_ASS_DIALOGUE: Lazy<Regex> = Lazy::new(|| {
    let pattern = format!("(?i){ASS_DIALOGUE}");
    Regex::new(&pattern).expect("ass dialogue pattern compiles")
});
static RE_ASS_FORMAT: Lazy<Regex> = Lazy::new(|| {
    let pattern = format!("(?i){ASS_FORMAT}");
    Regex::new(&pattern).expect("ass format pattern compiles")
});
static RE_ASS_EVENTS: Lazy<Regex> =
    Lazy::new(|| Regex::new(ASS_EVENTS).expect("ass events pattern compiles"));
static RE_ASS_SECTION: Lazy<Regex> =
    Lazy::new(|| Regex::new(ASS_SECTION).expect("ass section pattern compiles"));
static RE_VTT_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(ASS_VTT_HEADER).expect("vtt header pattern compiles"));
static RE_VTT_BLOCK_HEADER: Lazy<Regex> =
    Lazy::new(|| Regex::new(ASS_VTT_BLOCK_HEADER).expect("vtt block header pattern compiles"));
static RE_TITLE_EXT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(txt|md|markdown|srt|vtt|ass|ssa|epub|mobi|azw|azw3)$")
        .expect("title extension pattern compiles")
});

fn strip_bom(text: &str) -> String {
    text.strip_prefix('\u{feff}').unwrap_or(text).to_string()
}

fn normalize_line(value: &str) -> String {
    let cleaned = RE_ASS_OVERRIDE.replace_all(value, "");
    let cleaned = RE_HTML_TAG.replace_all(&cleaned, "");
    let cleaned = RE_ASS_BREAK.replace_all(&cleaned, " ");
    let cleaned = RE_BRACKETED.replace_all(&cleaned, "");
    let cleaned = RE_WHITESPACE.replace_all(cleaned.as_ref(), " ");
    cleaned.trim().to_string()
}

fn join_lines<I, S>(lines: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut output: Vec<String> = Vec::new();
    for raw in lines {
        let normalized = normalize_line(raw.as_ref());
        if normalized.is_empty() {
            continue;
        }
        if output
            .last()
            .map(|prev| prev == &normalized)
            .unwrap_or(false)
        {
            continue;
        }
        output.push(normalized);
    }
    output.join("\n")
}

pub fn parse_srt(text: &str) -> String {
    let body = strip_bom(text).replace("\r\n", "\n").replace('\r', "\n");
    join_lines(body.split('\n').map(str::trim).filter(|line| {
        !line.is_empty() && !RE_SEQUENCE.is_match(line) && !RE_SRT_TIMESTAMP.is_match(line)
    }))
}

pub fn parse_vtt(text: &str) -> String {
    let body = strip_bom(text).replace("\r\n", "\n").replace('\r', "\n");
    let mut skipping_block = false;
    let mut kept: Vec<&str> = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            skipping_block = false;
            continue;
        }
        if RE_VTT_HEADER.is_match(line) {
            continue;
        }
        if RE_VTT_BLOCK_HEADER.is_match(line) {
            skipping_block = true;
            continue;
        }
        if skipping_block {
            continue;
        }
        if RE_SEQUENCE.is_match(line) {
            continue;
        }
        if RE_VTT_TIMESTAMP.is_match(line) {
            continue;
        }
        kept.push(line);
    }
    join_lines(kept)
}

pub fn parse_ass(text: &str) -> String {
    let body = strip_bom(text).replace("\r\n", "\n").replace('\r', "\n");
    let mut in_events = false;
    let mut text_index: usize = 9;
    let mut kept: Vec<String> = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if RE_ASS_EVENTS.is_match(line) {
            in_events = true;
            continue;
        }
        if RE_ASS_SECTION.is_match(line) {
            in_events = false;
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(caps) = RE_ASS_FORMAT.captures(line) {
            let columns: Vec<String> = caps[1]
                .split(',')
                .map(|part| part.trim().to_lowercase())
                .collect();
            if let Some(idx) = columns.iter().position(|c| c == "text") {
                text_index = idx;
            }
            continue;
        }
        if let Some(caps) = RE_ASS_DIALOGUE.captures(line) {
            let fields: Vec<&str> = caps[1].split(',').collect();
            if fields.len() <= text_index {
                continue;
            }
            kept.push(fields[text_index..].join(","));
        }
    }
    join_lines(&kept)
}

pub fn parse_imported_text_file(name: &str, raw_text: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".ass") || lower.ends_with(".ssa") {
        return parse_ass(raw_text);
    }
    if lower.ends_with(".srt") {
        return parse_srt(raw_text);
    }
    if lower.ends_with(".vtt") {
        return parse_vtt(raw_text);
    }
    strip_bom(raw_text).trim().to_string()
}

pub fn title_from_imported_file_name(name: &str) -> String {
    RE_TITLE_EXT.replace(name, "").to_string()
}

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    match op {
        "parse" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let raw = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({ "text": parse_imported_text_file(name, raw) }))
        }
        "title" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({ "title": title_from_imported_file_name(name) }))
        }
        "srt" => {
            let raw = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({ "text": parse_srt(raw) }))
        }
        "vtt" => {
            let raw = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({ "text": parse_vtt(raw) }))
        }
        "ass" => {
            let raw = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(json!({ "text": parse_ass(raw) }))
        }
        other => Err(format!("unknown subtitles op: {other}")),
    }
}

#[cfg(test)]
#[path = "tests/subtitles/tests.rs"]
mod tests;
