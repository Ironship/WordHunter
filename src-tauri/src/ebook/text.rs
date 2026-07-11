use encoding_rs::WINDOWS_1250;
use regex::Regex;

pub(crate) fn decode_epub_text(data: &[u8]) -> String {
    if data.starts_with(&[0xEF, 0xBB, 0xBF])
        && let Ok(text) = std::str::from_utf8(&data[3..])
    {
        return text.to_string();
    }
    if let Ok(text) = std::str::from_utf8(data) {
        return text.to_string();
    }
    let (text, _, had_errors) = WINDOWS_1250.decode(data);
    if !had_errors {
        return text.into_owned();
    }
    data.iter().map(|byte| char::from(*byte)).collect()
}

pub(crate) fn clean_imported_ebook_text(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let trailing_space = Regex::new(r"[ \t]+\n").expect("valid regex");
    let multi_nl = Regex::new(r"\n{3,}").expect("valid regex");
    let text = trailing_space.replace_all(&text, "\n");
    multi_nl.replace_all(&text, "\n\n").trim().to_string()
}

pub(crate) fn strip_xhtml_to_text(markup: &str) -> String {
    let skip_tags = Regex::new(
        r"(?is)<(?:script|style|head|svg|math)\b[^>]*>.*?</(?:script|style|head|svg|math)>",
    )
    .expect("valid regex");
    let block_tags = Regex::new(r"(?i)</?(p|div|section|article|chapter|br|li|tr|h[1-6])\b[^>]*>")
        .expect("valid regex");
    let tags = Regex::new(r"(?s)<[^>]+>").expect("valid regex");
    let whitespace = Regex::new(r"\s+").expect("valid regex");
    let repeated_boundaries = Regex::new(r"(?:\s*\u{E000}\s*)+").expect("valid regex");
    let text = skip_tags.replace_all(markup, "");
    let text = block_tags.replace_all(&text, "\u{E000}");
    let text = tags.replace_all(&text, "");
    let text = html_escape::decode_html_entities(&text);
    let text = whitespace.replace_all(text.as_ref(), " ");
    repeated_boundaries
        .replace_all(text.as_ref(), "\n")
        .trim()
        .to_string()
}
