use encoding_rs::{Encoding, WINDOWS_1250};
use regex::Regex;

pub(crate) fn decode_epub_text(data: &[u8]) -> String {
    if let Some((encoding, bom_len)) = Encoding::for_bom(data) {
        let (text, _, _) = encoding.decode(&data[bom_len..]);
        return text.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(data) {
        return text.to_string();
    }
    let header_len = data.len().min(4096);
    let header = String::from_utf8_lossy(&data[..header_len]);
    let declared = Regex::new(r#"(?i)(?:encoding\s*=\s*|charset\s*=\s*)[\"']?([a-z0-9._-]+)"#)
        .expect("valid encoding declaration regex")
        .captures(&header)
        .and_then(|captures| captures.get(1))
        .and_then(|label| Encoding::for_label(label.as_str().as_bytes()));
    if let Some(encoding) = declared {
        let (text, _, _) = encoding.decode(data);
        return text.into_owned();
    }
    let (text, _, had_errors) = WINDOWS_1250.decode(data);
    if !had_errors {
        return text.into_owned();
    }
    data.iter().map(|byte| char::from(*byte)).collect()
}

#[cfg(test)]
mod tests {
    use super::decode_epub_text;

    #[test]
    fn decodes_utf8_and_utf16_bom_text() {
        assert_eq!(decode_epub_text(&[0xef, 0xbb, 0xbf, b'O', b'K']), "OK");
        assert_eq!(
            decode_epub_text(&[0xff, 0xfe, b'Z', 0, b'a', 0, 0x7c, 0x01]),
            "Zaż"
        );
        assert_eq!(
            decode_epub_text(&[0xfe, 0xff, 0, b'Z', 0, b'a', 0x01, 0x7c]),
            "Zaż"
        );
    }

    #[test]
    fn respects_declared_legacy_xhtml_encoding() {
        let mut bytes = br#"<?xml version="1.0" encoding="windows-1252"?><p>caf"#.to_vec();
        bytes.extend_from_slice(&[0xe9]);
        bytes.extend_from_slice(b"</p>");

        assert!(decode_epub_text(&bytes).contains("café"));
    }
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
