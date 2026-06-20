use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

use crate::store::Store;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
        .unwrap_or(0);

    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    let pages_dir = temp.path().join("pages");
    let json_path = temp.path().join("ocr.json");
    fs::create_dir_all(&pages_dir).map_err(|e| e.to_string())?;
    fs::write(&input_path, data).map_err(|e| e.to_string())?;

    let runner = find_runner(app_handle)?;
    let result = run_runner(
        &runner,
        &input_path,
        &pages_dir,
        &json_path,
        &lang,
        max_pages,
        temp.path(),
        book_id,
        cancellations,
    );
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .remove(book_id);
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
    let book_id = payload
        .get("book_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "book_id required".to_string())?;
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .insert(book_id.to_string());
    Ok(())
}

static GPU_STATUS: OnceLock<Value> = OnceLock::new();

pub fn gpu_status(app_handle: &AppHandle) -> Value {
    GPU_STATUS
        .get_or_init(|| probe_gpu_status(app_handle))
        .clone()
}

fn probe_gpu_status(app_handle: &AppHandle) -> Value {
    let Ok(runner) = find_runner(app_handle) else {
        return gpu_status_value("failed");
    };

    let mut command = Command::new(&runner);
    command
        .arg("--gpu-status")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = runner.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(output) = command.output() else {
        return gpu_status_value("failed");
    };
    if !output.status.success() {
        return gpu_status_value("failed");
    }
    let status = serde_json::from_slice::<Value>(&output.stdout)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    gpu_status_value(status.as_deref().unwrap_or("failed"))
}

fn gpu_status_value(status: &str) -> Value {
    match status {
        "ready" | "unavailable" => json!({ "status": status }),
        _ => json!({ "status": "failed" }),
    }
}

#[cfg(test)]
mod tests {
    use super::gpu_status_value;

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
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())
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

fn runner_name() -> &'static str {
    if cfg!(windows) {
        "wordhunter-paddleocr.exe"
    } else {
        "wordhunter-paddleocr"
    }
}

fn find_runner(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let candidates = runner_candidates(app_handle);
    if let Some(path) = candidates.iter().find(|path| path.is_file()) {
        return Ok(path.clone());
    }

    let searched = candidates
        .iter()
        .map(|path| format!("  - {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "PaddleOCR native runner was not found. Bundle {} under src-tauri/ocr-runtime/bin or set WORDHUNTER_PADDLEOCR_RUNNER.\nSearched:\n{}",
        runner_name(),
        searched
    ))
}

fn runner_candidates(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("WORDHUNTER_PADDLEOCR_RUNNER") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("ocr-runtime")
                .join("bin")
                .join(runner_name()),
        );
        candidates.push(resource_dir.join("ocr-runtime").join(runner_name()));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("ocr-runtime").join("bin").join(runner_name()));
            candidates.push(
                exe_dir
                    .join("resources")
                    .join("ocr-runtime")
                    .join("bin")
                    .join(runner_name()),
            );
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("ocr-runtime")
            .join("bin")
            .join(runner_name()),
    );
    candidates
}

fn run_runner(
    runner: &Path,
    input_path: &Path,
    pages_dir: &Path,
    json_path: &Path,
    lang: &str,
    max_pages: u64,
    work_dir: &Path,
    book_id: &str,
    cancellations: &Mutex<HashSet<String>>,
) -> Result<(), String> {
    let stdout_path = work_dir.join("paddleocr.stdout.log");
    let stderr_path = work_dir.join("paddleocr.stderr.log");
    let stdout = File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|e| e.to_string())?;

    let mut command = Command::new(runner);
    command
        .arg("--input")
        .arg(input_path)
        .arg("--output-dir")
        .arg(pages_dir)
        .arg("--json")
        .arg(json_path)
        .arg("--lang")
        .arg(lang)
        .arg("--max-pages")
        .arg(max_pages.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(parent) = runner.parent() {
        command.current_dir(parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start PaddleOCR runner {}: {e}", runner.display()))?;
    loop {
        if cancellations
            .lock()
            .map_err(|_| "OCR cancellation state is unavailable".to_string())?
            .contains(book_id)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PaddleOCR import cancelled".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "PaddleOCR runner failed with exit code {}.\n{}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                log_excerpt(&stdout_path, &stderr_path)
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn log_excerpt(stdout_path: &Path, stderr_path: &Path) -> String {
    let stdout = read_tail(stdout_path);
    let stderr = read_tail(stderr_path);
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => "No runner logs were captured.".to_string(),
        (false, true) => format!("stdout:\n{stdout}"),
        (true, false) => format!("stderr:\n{stderr}"),
        (false, false) => format!("stdout:\n{stdout}\nstderr:\n{stderr}"),
    }
}

fn read_tail(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let chars = text.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(4000);
    chars[start..].iter().collect::<String>().trim().to_string()
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
