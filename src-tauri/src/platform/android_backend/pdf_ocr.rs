use std::sync::Mutex;

use base64::Engine;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::{
    pdf_text_layer::{self, OverlayPage},
    server::OcrJobState,
    store::Store,
};

const MAX_PDF_BYTES: usize = 400 * 1024 * 1024;
const MAX_PAGES: usize = 2_000;
const MAX_TEXT_LAYER_CHARS: usize = 2_000_000;
const TEXT_LAYER_EMPTY: &str = "PDF_TEXT_LAYER_EMPTY";

pub fn import(
    payload: Value,
    store: &Store,
    _app_handle: &AppHandle,
    _jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let data = decode_payload(data_url)?;
    import_decoded(payload, &data, store)
}

pub fn import_bytes(
    payload: Value,
    data: Vec<u8>,
    store: &Store,
    _app_handle: &AppHandle,
    _jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    if data.len() > MAX_PDF_BYTES {
        return Err("PDF is too large for Pocket import (max 400 MB)".to_string());
    }
    import_decoded(payload, &data, store)
}

pub fn import_image_bytes(
    _payload: Value,
    _data: Vec<u8>,
    _store: &Store,
    _app_handle: &AppHandle,
    _jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    Err("Image OCR is only packaged for Windows and Linux".to_string())
}

fn import_decoded(payload: Value, data: &[u8], store: &Store) -> Result<Value, String> {
    let book_id = payload
        .get("book_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "book_id required".to_string())?;
    let requested_max_pages = payload
        .get("max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_PAGES as u64);
    let max_pages = if requested_max_pages == 0 {
        MAX_PAGES
    } else {
        requested_max_pages.min(MAX_PAGES as u64) as usize
    };
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("PDF");
    let (pages, page_count, truncated) = extract_overlay_pages(data, max_pages)?;
    let text = pages
        .iter()
        .map(|page| page.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if readable_chars(&text) < 3 || pages.iter().any(|page| readable_chars(&page.text) < 3) {
        return Err(TEXT_LAYER_EMPTY.to_string());
    }
    store.begin_book_import_assets(book_id)?;

    Ok(json!({
        "title": title_from_filename(filename),
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": page_count,
        "truncated": truncated,
        "ocrEngine": "android-pdf-text-layer+pdf-renderer",
        "experimental": true,
        "blurb": ""
    }))
}

pub fn cancel(payload: Value, jobs: &Mutex<OcrJobState>) -> Result<(), String> {
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    let cancelled = jobs
        .lock()
        .map_err(|_| "OCR job state is unavailable".to_string())?
        .request_cancel(job_id);
    if !cancelled {
        return Err("OCR job is not active".to_string());
    }
    Ok(())
}

pub fn gpu_status(_app_handle: &AppHandle) -> Value {
    json!({ "status": "unavailable", "reason": "desktop-only" })
}

pub fn image_ocr_available(_app_handle: &AppHandle) -> bool {
    false
}

fn decode_payload(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    if encoded.len() > MAX_PDF_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("PDF is too large for Pocket import (max 400 MB)".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_PDF_BYTES {
        return Err("PDF is too large for Pocket import (max 400 MB)".to_string());
    }
    Ok(data)
}

fn readable_chars(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn extract_overlay_pages(
    data: &[u8],
    max_pages: usize,
) -> Result<(Vec<OverlayPage>, usize, bool), String> {
    pdf_text_layer::extract_overlay_pages(data, max_pages, Some(MAX_TEXT_LAYER_CHARS))
}

fn title_from_filename(filename: &str) -> String {
    std::path::Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("PDF")
        .to_string()
}
