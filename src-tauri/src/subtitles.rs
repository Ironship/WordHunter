use regex::Regex;
use std::sync::LazyLock;

const ASS_OVERRIDE: &str = r"\{[^}]*\}";
const HTML_TAG: &str = r"</?[^>]+>";
const ASS_BREAK: &str = r"\\[Nnh]";
const BRACKETED: &str = r"\[[^\]]*\]";
const WHITESPACE: &str = r"\s+";
const VTT_TIMESTAMP: &str =
    r"(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}";
const SEQUENCE_NUMBER: &str = r"^\d+$";
const ASS_VTT_HEADER: &str = r"(?i)^WEBVTT($|\s)";
const ASS_VTT_BLOCK_HEADER: &str = r"(?i)^(NOTE|STYLE|REGION)(:|\s|$)";
const VTT_METADATA: &str = r"(?i)^(Kind|Language):\s*";

static RE_ASS_OVERRIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(ASS_OVERRIDE).unwrap());
static RE_HTML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(HTML_TAG).unwrap());
static RE_ASS_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(ASS_BREAK).unwrap());
static RE_BRACKETED: LazyLock<Regex> = LazyLock::new(|| Regex::new(BRACKETED).unwrap());
static RE_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(WHITESPACE).unwrap());
static RE_VTT_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(VTT_TIMESTAMP).unwrap());
static RE_SEQUENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(SEQUENCE_NUMBER).unwrap());
static RE_VTT_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(ASS_VTT_HEADER).expect("vtt header pattern compiles"));
static RE_VTT_BLOCK_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(ASS_VTT_BLOCK_HEADER).expect("vtt block header pattern compiles"));
static RE_VTT_METADATA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(VTT_METADATA).expect("vtt metadata pattern compiles"));

fn strip_bom(text: &str) -> String {
    text.strip_prefix('\u{feff}').unwrap_or(text).to_string()
}

fn normalize_line(value: &str) -> String {
    let visible: String = value
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}'
            )
        })
        .collect();
    let cleaned = RE_ASS_OVERRIDE.replace_all(&visible, "");
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
        if line == "##" {
            skipping_block = false;
            continue;
        }
        if RE_VTT_METADATA.is_match(line) {
            continue;
        }
        if RE_VTT_BLOCK_HEADER.is_match(line) {
            skipping_block = true;
            continue;
        }
        if skipping_block {
            continue;
        }
        if line.starts_with("::cue") || line == "}" {
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
