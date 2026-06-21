use serde_json::{json, Value};
use std::fs::File;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) static GPU_STATUS: OnceLock<Value> = OnceLock::new();

pub(crate) fn gpu_status_value(status: &str) -> Value {
    match status {
        "ready" | "unavailable" => json!({ "status": status }),
        _ => json!({ "status": "failed" }),
    }
}

pub(crate) fn probe_gpu_status(app_handle: &AppHandle) -> Value {
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

fn runner_name() -> &'static str {
    if cfg!(windows) {
        "wordhunter-paddleocr.exe"
    } else {
        "wordhunter-paddleocr"
    }
}

pub(crate) fn find_runner(app_handle: &AppHandle) -> Result<PathBuf, String> {
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

pub(crate) fn run_runner(
    runner: &Path,
    input_path: &Path,
    pages_dir: &Path,
    json_path: &Path,
    lang: &str,
    max_pages: u64,
    work_dir: &Path,
    job_id: &str,
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
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    loop {
        if cancellations
            .lock()
            .map_err(|_| "OCR cancellation state is unavailable".to_string())?
            .contains(job_id)
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
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PaddleOCR import timed out after 1 hour".to_string());
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
