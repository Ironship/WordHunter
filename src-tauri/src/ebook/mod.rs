mod calibre;
mod epub;
pub(crate) mod text;

use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;

use self::calibre::convert_with_calibre;
use self::epub::parse_epub;

#[cfg(test)]
pub(crate) use self::epub::epub_href;
#[cfg(test)]
pub(crate) use self::text::strip_xhtml_to_text;

pub fn import(payload: Value) -> Result<Value, String> {
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("");
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let suffix = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let title = Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Imported ebook")
        .to_string();

    match suffix.as_str() {
        "epub" => parse_epub(&data, &title),
        "mobi" | "azw" | "azw3" => {
            let text = convert_with_calibre(&data, &format!(".{suffix}"))?;
            if text.is_empty() {
                return Err("No readable text found after ebook-convert".to_string());
            }
            Ok(json!({
                "title": title,
                "author": "",
                "text": text,
                "coverDataUrl": ""
            }))
        }
        _ => Err("Unsupported ebook format".to_string()),
    }
}

#[cfg(test)]
#[path = "../tests/ebook/tests.rs"]
mod tests;
