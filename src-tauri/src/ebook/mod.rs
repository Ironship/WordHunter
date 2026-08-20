mod calibre;
mod epub;
pub(crate) mod text;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::path::Path;

use self::calibre::convert_with_calibre;
use self::epub::parse_epub;

const MAX_EBOOK_BYTES: usize = 64 * 1024 * 1024;

#[cfg(test)]
pub(crate) use self::epub::epub_href;
#[cfg(test)]
pub(crate) use self::text::strip_xhtml_to_text;

/// Borrowed view of the ebook-import request body.
///
/// The `data` field is a base64-encoded payload that can be tens of MiB (a
/// 64 MiB ebook is ~85 MiB of base64). Deserializing straight from the raw
/// request buffer keeps those strings zero-copy (`Cow::Borrowed`), so we never
/// build an intermediate `serde_json::Value` that would duplicate the payload
/// in memory — the ebook endpoint used to hold the raw body *and* the parsed
/// base64 string at the same time (a ~2x double-buffer on the 384 MiB-class
/// import limit). Escaped strings still fall back to `Cow::Owned` safely.
#[derive(Deserialize)]
pub(crate) struct EbookImportRequest<'a> {
    #[serde(borrow)]
    filename: Cow<'a, str>,
    #[serde(borrow)]
    data: Cow<'a, str>,
}

fn decode_ebook_payload_with_limit(data_url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    let max_encoded_bytes = (max_bytes.saturating_mul(4) / 3).saturating_add(4);
    if encoded.len() > max_encoded_bytes {
        return Err("ebook payload is too large".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > max_bytes {
        return Err("ebook payload is too large".to_string());
    }
    Ok(data)
}

/// Parse and import an ebook from a raw `{filename, data}` JSON request body.
///
/// The router first streams the body into a `Vec<u8>` via
/// `response::read_body_limited`, then `parse_import_body` deserializes it
/// directly into a borrowing struct — no intermediate `serde_json::Value`, so
/// a tens-of-MiB base64 payload is never duplicated in memory. `Err` from
/// `parse_import_body` means malformed/empty JSON (HTTP 400) while `Err` from
/// `import_request` is an import failure (HTTP 422).
pub(crate) fn parse_import_body(body: &[u8]) -> Result<EbookImportRequest<'_>, String> {
    if body.is_empty() {
        return Ok(EbookImportRequest {
            filename: Cow::Borrowed(""),
            data: Cow::Borrowed(""),
        });
    }
    serde_json::from_slice(body).map_err(|e| format!("invalid JSON body: {e}"))
}

pub(crate) fn import_request(request: &EbookImportRequest<'_>) -> Result<Value, String> {
    import_parts(request.filename.as_ref(), request.data.as_ref())
}

pub fn import(payload: Value) -> Result<Value, String> {
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("");
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    import_parts(filename, data_url)
}

fn import_parts(filename: &str, data_url: &str) -> Result<Value, String> {
    let data = decode_ebook_payload_with_limit(data_url, MAX_EBOOK_BYTES)?;
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
