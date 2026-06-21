use base64::Engine;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path, sync::Mutex};
use tauri::AppHandle;

use crate::store::Store;

mod runner;

const MAX_PDF_BYTES: usize = 1024 * 1024 * 1024;
const MAX_PAGES: u64 = 2_000;

pub fn import(
    payload: Value,
    store: &Store,
    app_handle: &AppHandle,
    cancellations: &Mutex<HashSet<String>>,
) -> Result<Value, String> {
    let book_id = payload
        .get("book_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "book_id required".to_string())?;
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("PDF OCR");
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let data = decode_payload(data_url)?;

    let lang = requested_lang(&payload);
    let max_pages = payload
        .get("max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(MAX_PAGES);

    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    let pages_dir = temp.path().join("pages");
    let json_path = temp.path().join("ocr.json");
    fs::create_dir_all(&pages_dir).map_err(|e| e.to_string())?;
    fs::write(&input_path, data).map_err(|e| e.to_string())?;

    let runner_path = runner::find_runner(app_handle)?;
    let result = runner::run_runner(
        &runner_path,
        &input_path,
        &pages_dir,
        &json_path,
        &lang,
        max_pages,
        temp.path(),
        job_id,
        cancellations,
    );
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .remove(job_id);
    result?;

    let output = read_runner_output(&json_path)?;
    let mut pages = output
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "PaddleOCR runner did not return a pages array".to_string())?;
    if pages.is_empty() {
        return Err("PaddleOCR did not return any pages".to_string());
    }

    let mut text_parts = Vec::new();
    for page in &mut pages {
        let image_name = page
            .get("imageName")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "PaddleOCR page is missing imageName".to_string())?;
        let safe_image_name = crate::paths::sanitize_id(image_name)?;
        let image_path = pages_dir.join(&safe_image_name);
        let image_bytes = fs::read(&image_path)
            .map_err(|e| format!("could not read OCR page image {safe_image_name}: {e}"))?;
        store.save_book_image_bytes(book_id, &safe_image_name, &image_bytes)?;
        if let Some(obj) = page.as_object_mut() {
            obj.insert("imageName".to_string(), json!(safe_image_name));
        }

        let page_text = extract_page_text(page);
        if !page_text.is_empty() {
            text_parts.push(page_text);
        }
    }

    let text = text_parts.join("\n\n").trim().to_string();
    if text.is_empty() {
        return Err("PaddleOCR did not find readable text in this PDF".to_string());
    }

    let page_count = output
        .get("pageCount")
        .and_then(Value::as_u64)
        .unwrap_or(pages.len() as u64);
    let truncated = output
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(page_count > pages.len() as u64);
    let ocr_engine = output
        .get("ocrEngine")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("paddleocr-cpp");
    let title = title_from_filename(filename);

    Ok(json!({
        "title": title,
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": page_count,
        "truncated": truncated,
        "ocrEngine": ocr_engine,
        "experimental": true,
        "blurb": ""
    }))
}

pub fn cancel(payload: Value, cancellations: &Mutex<HashSet<String>>) -> Result<(), String> {
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .insert(job_id.to_string());
    Ok(())
}

pub fn gpu_status(app_handle: &AppHandle) -> Value {
    runner::GPU_STATUS
        .get_or_init(|| runner::probe_gpu_status(app_handle))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::runner::gpu_status_value;

    #[test]
    fn gpu_status_uses_safe_cpu_states() {
        assert_eq!(gpu_status_value("ready")["status"], "ready");
        assert_eq!(gpu_status_value("unavailable")["status"], "unavailable");
        assert_eq!(gpu_status_value("unexpected")["status"], "failed");
    }
}

fn decode_payload(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    if encoded.len() > MAX_PDF_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_PDF_BYTES {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    Ok(data)
}

fn requested_lang(payload: &Value) -> String {
    let lang = payload.get("lang").and_then(Value::as_str).unwrap_or("en");
    let sanitized: String = lang
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(16)
        .collect();
    if sanitized.is_empty() {
        "en".to_string()
    } else {
        sanitized
    }
}

fn read_runner_output(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("PaddleOCR runner did not write OCR JSON: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("PaddleOCR runner wrote invalid JSON: {e}"))
}

fn extract_page_text(page: &Value) -> String {
    if let Some(text) = page
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }

    let words = page
        .get("words")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if !words.is_empty() {
        return words.join(" ");
    }

    page.get("lines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| item.get("text").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn title_from_filename(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("PDF OCR")
        .to_string()
}
