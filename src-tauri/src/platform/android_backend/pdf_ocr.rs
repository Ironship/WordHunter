use std::{collections::HashSet, sync::Mutex};

use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::store::Store;

const MAX_PDF_BYTES: usize = 128 * 1024 * 1024;
const TEXT_LAYER_EMPTY: &str = "PDF_TEXT_LAYER_EMPTY";

pub fn import(
    payload: Value,
    _store: &Store,
    _app_handle: &AppHandle,
    _cancellations: &Mutex<HashSet<String>>,
) -> Result<Value, String> {
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("PDF");
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let data = decode_payload(data_url)?;
    let pages = pdf_extract::extract_text_from_mem_by_pages(&data)
        .map_err(|e| format!("Could not read the PDF text layer: {e}"))?;
    let page_count = pages.len();
    let clean_pages = pages
        .into_iter()
        .map(|page| page.trim().to_string())
        .filter(|page| !page.is_empty())
        .collect::<Vec<_>>();
    let text = clean_pages.join("\n\n");
    if readable_chars(&text) < 3 {
        return Err(TEXT_LAYER_EMPTY.to_string());
    }

    Ok(json!({
        "title": title_from_filename(filename),
        "text": text,
        "coverDataUrl": "",
        "pages": [],
        "pageCount": page_count,
        "truncated": false,
        "ocrEngine": "pdf-text-layer",
        "experimental": false,
        "blurb": ""
    }))
}

pub fn cancel(_payload: Value, _cancellations: &Mutex<HashSet<String>>) -> Result<(), String> {
    Ok(())
}

pub fn gpu_status(_app_handle: &AppHandle) -> Value {
    json!({ "status": "unavailable", "reason": "desktop-only" })
}

fn decode_payload(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    if encoded.len() > MAX_PDF_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("PDF is too large for Pocket import (max 128 MB)".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_PDF_BYTES {
        return Err("PDF is too large for Pocket import (max 128 MB)".to_string());
    }
    Ok(data)
}

fn readable_chars(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn title_from_filename(filename: &str) -> String {
    std::path::Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("PDF")
        .to_string()
}
