use serde_json::{Value, json};
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
    let provider = if status != "ready" {
        "cpu"
    } else if cfg!(windows) {
        "directml"
    } else if cfg!(target_os = "linux") {
        "webgpu"
    } else {
        "cpu"
    };
    gpu_status_value_with_provider(status, provider)
}

pub(crate) fn gpu_status_value_with_provider(status: &str, provider: &str) -> Value {
    match status {
        "ready" if matches!(provider, "directml" | "webgpu") => {
            json!({ "status": status, "provider": provider })
        }
        "unavailable" => json!({ "status": status, "provider": "cpu" }),
        _ => json!({ "status": "failed", "provider": "cpu" }),
    }
}

pub(crate) fn platform_gpu_status_without_runner() -> Option<Value> {
    if cfg!(any(windows, target_os = "linux")) {
        None
    } else {
        Some(gpu_status_value("unavailable"))
    }
}

pub(crate) fn probe_gpu_status(app_handle: &AppHandle) -> Value {
    if let Some(status) = platform_gpu_status_without_runner() {
        return status;
    }

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
    let parsed = serde_json::from_slice::<Value>(&output.stdout).ok();
    let status = parsed
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let provider = parsed
        .as_ref()
        .and_then(|value| value.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("cpu");
    gpu_status_value_with_provider(status, provider)
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
    if let Ok(path) = std::env::var("WORDHUNTER_PADDLEOCR_RUNNER")
        && !path.trim().is_empty()
    {
        candidates.push(PathBuf::from(path));
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

    if let Ok(current_exe) = std::env::current_exe()
        && let Some(exe_dir) = current_exe.parent()
    {
        candidates.push(exe_dir.join("ocr-runtime").join("bin").join(runner_name()));
        candidates.push(
            exe_dir
                .join("resources")
                .join("ocr-runtime")
                .join("bin")
                .join(runner_name()),
        );
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("ocr-runtime")
            .join("bin")
            .join(runner_name()),
    );
    candidates
}

pub(crate) struct RunnerJob<'a> {
    pub input_path: &'a Path,
    pub pages_dir: &'a Path,
    pub json_path: &'a Path,
    pub lang: &'a str,
    pub max_pages: u64,
    pub work_dir: &'a Path,
    pub job_id: &'a str,
    pub cancellations: &'a Mutex<HashSet<String>>,
}

pub(crate) fn run_runner(runner: &Path, job: RunnerJob<'_>) -> Result<(), String> {
    let stdout_path = job.work_dir.join("paddleocr.stdout.log");
    let stderr_path = job.work_dir.join("paddleocr.stderr.log");
    let stdout = File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|e| e.to_string())?;

    let mut command = Command::new(runner);
    command
        .arg("--input")
        .arg(job.input_path)
        .arg("--output-dir")
        .arg(job.pages_dir)
        .arg("--json")
        .arg(job.json_path)
        .arg("--lang")
        .arg(job.lang)
        .arg("--max-pages")
        .arg(job.max_pages.to_string())
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
        if job
            .cancellations
            .lock()
            .map_err(|_| "OCR cancellation state is unavailable".to_string())?
            .contains(job.job_id)
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
