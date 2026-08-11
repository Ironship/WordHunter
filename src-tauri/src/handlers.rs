use rand::{Rng, distributions::Alphanumeric};
use serde_json::Value;
use std::path::{Component, Path};
use std::{fs, path::PathBuf};
use tauri::Manager;
use tiny_http::Request;

use crate::store::transfer::ExportScope;
use crate::{offline_translator, response, server::ServerState, tts};

/// Open an http(s) URL in the system default browser. Called from the
/// frontend when a top-level window is needed (YouGlish fallback, source
/// links): plain `window.open` from an async callback is popup-blocked in
/// the webview, so the embedded server does the opening instead.
///
/// The URL is validated strictly (parseable, http/https scheme, host
/// present) and opened via the `open` crate's detached API. On Windows its
/// `shellexecute-on-windows` feature calls ShellExecuteExW directly — never
/// `cmd /c start`, whose quoting allowed command injection through a URL.
/// Validate an external URL without any side effects: parseable, http/https
/// scheme, host present, no control characters. Pure — unit-testable.
fn validate_external_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(|c| c.is_control()) {
        return Err("refusing to open an empty or control-character URL".to_string());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("refusing to open a non-http URL".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("URL is missing a host".to_string());
    }
    Ok(())
}

pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    validate_external_url(url)?;
    #[cfg(target_os = "android")]
    {
        // Android opens URLs through the Java bridge (openAndroidUrl), not
        // this endpoint.
        Err("external URLs are opened through the Android bridge".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        open::that_detached(url).map_err(|e| format!("could not open the default browser: {e}"))
    }
}

pub(crate) fn parse_window_zoom_percent(payload: &Value) -> Result<f64, String> {
    let percent = payload
        .get("percent")
        .and_then(Value::as_u64)
        .ok_or_else(|| "window zoom requires an integer percent".to_string())?;
    if !(80..=150).contains(&percent) {
        return Err("window zoom percent must be between 80 and 150".to_string());
    }
    Ok(percent as f64 / 100.0)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn set_window_zoom(state: &ServerState, scale_factor: f64) -> Result<(), String> {
    let window = state
        .app_handle
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    window
        .set_zoom(scale_factor)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub(crate) fn set_window_zoom(_state: &ServerState, _scale_factor: f64) -> Result<(), String> {
    Err("window zoom is unavailable on Android".to_string())
}

pub(crate) fn serve_index(request: Request, state: &ServerState) -> Result<(), String> {
    let index = crate::router::WEB_ASSETS
        .get_file("index.html")
        .ok_or_else(|| "embedded index.html was not found".to_string())?;
    let mut html = String::from_utf8(index.contents().to_vec()).map_err(|e| e.to_string())?;
    let bootstrap = bootstrap_script(
        &state.token,
        #[cfg(not(target_os = "android"))]
        Some(&state.store.snapshot()),
        #[cfg(target_os = "android")]
        None,
        crate::pdf_ocr::image_ocr_available(&state.app_handle),
    );
    if let Some(pos) = html.find("<head>") {
        html.insert_str(
            pos + "<head>".len(),
            &format!("\n<script>{bootstrap}</script>"),
        );
    } else {
        html.insert_str(0, &format!("<script>{bootstrap}</script>"));
    }
    response::respond(
        request,
        200,
        html.into_bytes(),
        "text/html; charset=utf-8",
        false,
    )
}

fn escape_inline_json(value: &Value) -> String {
    serde_json::to_string(value)
        .expect("serializing a JSON value cannot fail")
        .replace("</", "<\\/")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

const BOOTSTRAP_TEMPLATE: &str = include_str!("../templates/bootstrap.js");

pub(crate) fn bootstrap_script(
    token: &str,
    snapshot: Option<&Value>,
    image_ocr_available: bool,
) -> String {
    let escaped = escape_inline_json(&Value::String(token.to_string()));
    let snapshot = snapshot
        .map(escape_inline_json)
        .unwrap_or_else(|| "null".to_string());
    crate::template::render_template(
        BOOTSTRAP_TEMPLATE,
        &[
            ("__WH_TOKEN_JSON__", escaped.as_str()),
            (
                "__WH_IMAGE_OCR_AVAILABLE__",
                if image_ocr_available { "true" } else { "false" },
            ),
            ("__WH_SNAPSHOT_JSON__", snapshot.as_str()),
        ],
    )
    .expect("bootstrap template placeholders must be present")
}

pub(crate) fn serve_static(request: Request, path: &str) -> Result<(), String> {
    let relative = match sanitize_relative_path(path.trim_start_matches('/')) {
        Ok(relative) => relative,
        Err(error) => return response::error_response(request, 400, &error),
    };
    let asset_path = relative.to_string_lossy().replace('\\', "/");
    let Some(file) = crate::router::WEB_ASSETS.get_file(&asset_path) else {
        return response::error_response(request, 404, "not found");
    };
    let mime = mime_guess::from_path(&asset_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    response::respond(request, 200, file.contents().to_vec(), &mime, true)
}

pub(crate) fn sanitize_relative_path(path: &str) -> Result<PathBuf, String> {
    let mut output = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => output.push(part),
            Component::CurDir => {}
            _ => return Err("invalid path".to_string()),
        }
    }
    Ok(output)
}

pub(crate) fn serve_media(
    request: Request,
    state: &ServerState,
    query: &str,
) -> Result<(), String> {
    let book = response::query_value(query, "book").unwrap_or_default();
    let img = response::query_value(query, "img").unwrap_or_default();
    if book.is_empty() || img.is_empty() {
        return response::error_response(request, 400, "book and img are required");
    }
    let file_path = match state.store.book_image_path(&book, &img) {
        Ok(path) => path,
        Err(_) => return response::error_response(request, 400, "invalid media path"),
    };
    let file = match fs::File::open(&file_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return response::error_response(request, 404, "not found");
        }
        Err(_) => return response::error_response(request, 500, "could not open media"),
    };
    let length = match file.metadata() {
        Ok(metadata) => metadata.len() as usize,
        Err(_) => return response::error_response(request, 500, "could not read media metadata"),
    };
    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    response::respond_reader(request, 200, file, length, &mime, true)
}

pub(crate) fn serve_edge_tts(request: Request, query: &str) -> Result<(), String> {
    let text = response::query_value(query, "text").unwrap_or_default();
    let lang = response::query_value(query, "lang").unwrap_or_else(|| "pl".into());
    let rate = response::query_value(query, "rate").unwrap_or_else(|| "normal".into());
    if text.trim().is_empty() {
        return response::error_response(request, 400, "TTS text is empty");
    }
    if text.chars().count() > 500 {
        return response::error_response(request, 400, "TTS text is too long (max 500 characters)");
    }

    match tts::synthesize(&text, &lang, &rate) {
        Ok(result) => {
            #[cfg(not(target_os = "android"))]
            let (audio, timings) = {
                use std::fmt::Write;
                let mut timings = String::with_capacity(result.boundaries.len() * 8);
                for (index, event) in result.boundaries.iter().enumerate() {
                    if index > 0 {
                        timings.push(',');
                    }
                    let _ = write!(timings, "{}", event.offset_ticks / 10_000);
                }
                (result.audio, timings)
            };
            #[cfg(target_os = "android")]
            let (audio, timings) = (result, String::new());
            response::respond_with_headers(
                request,
                200,
                audio,
                "audio/mpeg",
                false,
                &[("X-WH-Word-Timings", &timings)],
            )
        }
        Err(err) => response::error_response(request, 502, &format!("Edge TTS failed: {err}")),
    }
}

pub(crate) fn serve_offline_translator_ui(request: Request, query: &str) -> Result<(), String> {
    let template = crate::router::WEB_ASSETS
        .get_file("templates/translator-popup.html")
        .ok_or_else(|| "translator template missing".to_string())?;
    let html = offline_translator::popup_html(query, template.contents())?;
    response::respond(request, 200, html, "text/html; charset=utf-8", false)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn save_export(payload: Value) -> Result<bool, String> {
    let data = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("export.txt");
    validate_export_filename(filename)?;
    if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() {
        write_export_file(&path, data)?;
        return Ok(true);
    }
    Ok(false)
}

/// Rejects export filenames that could escape the save dialog or name a
/// directory: empty names, path separators, the ".." component, and names
/// longer than 255 bytes (fix #110 hardening).
#[cfg(not(target_os = "android"))]
pub(crate) fn validate_export_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("export filename is empty".to_string());
    }
    if filename.len() > 255 {
        return Err("export filename is longer than 255 bytes".to_string());
    }
    if filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
    {
        return Err(
            "export filename must be a plain file name without path separators".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn write_export_file(path: &std::path::Path, data: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = export_sidecar_path(path, ".wordhunter-export.tmp")?;
    crate::store::durable::remove_file_if_exists(&temp)?;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| format!("could not create export temp {}: {e}", temp.display()))?;
        file.write_all(data.as_bytes())
            .map_err(|e| format!("could not write export temp {}: {e}", temp.display()))?;
        file.sync_all()
            .map_err(|e| format!("could not sync export temp {}: {e}", temp.display()))?;
    }
    install_export_temp(path, &temp)
}

#[cfg(not(target_os = "android"))]
fn export_sidecar_path(path: &std::path::Path, suffix: &str) -> Result<std::path::PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("export path has no filename: {}", path.display()))?;
    let mut sidecar = name.to_os_string();
    sidecar.push(suffix);
    Ok(path.with_file_name(sidecar))
}

#[cfg(target_os = "android")]
pub(crate) fn save_export(_payload: Value) -> Result<bool, String> {
    Err("Export file picker is not available in Word Hunter Pocket yet".to_string())
}

#[cfg(not(target_os = "android"))]
pub(crate) struct ExportJob {
    progress: crate::store::transfer::ExportProgress,
}

#[cfg(not(target_os = "android"))]
impl ExportJob {
    pub(crate) fn new(progress: crate::store::transfer::ExportProgress) -> Self {
        Self { progress }
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.progress
            .snapshot()
            .get("done")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn export_transfer(state: &ServerState, payload: &Value) -> Result<Value, String> {
    let scope = ExportScope::parse(
        payload
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("all"),
    )?;
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("wordhunter-transfer.zip");
    validate_export_filename(filename)?;
    let Some(path) = rfd::FileDialog::new()
        .add_filter("WordHunter package", &["zip"])
        .set_file_name(filename)
        .save_file()
    else {
        return Ok(serde_json::json!({ "saved": false }));
    };
    let temp = export_sidecar_path(&path, ".wordhunter-export.tmp")?;
    crate::store::durable::remove_file_if_exists(&temp)?;
    // Run the ZIP build on a background thread and publish stage progress so
    // the frontend can show a 0–100% bar instead of a frozen button.
    let job_id = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect::<String>();
    let progress = crate::store::transfer::ExportProgress::new();
    if let Ok(mut jobs) = state.exports.lock() {
        jobs.retain(|_, job| !job.is_terminal());
        jobs.insert(job_id.clone(), ExportJob::new(progress.clone()));
    }
    let store = state.store.clone();
    let target = path.clone();
    std::thread::spawn(move || {
        let result = store.export_transfer(&temp, scope, Some(&progress));
        match result {
            Ok(summary) => {
                if let Err(error) = install_export_temp(&target, &temp) {
                    progress.set_error(error);
                    return;
                }
                progress.set_done(summary);
            }
            Err(error) => progress.set_error(error),
        }
    });
    Ok(serde_json::json!({ "saved": false, "job": job_id }))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn export_progress(state: &ServerState, query: &str) -> Result<Value, String> {
    let job_id = crate::paths::sanitize_id(
        response::query_value(query, "job")
            .as_deref()
            .unwrap_or_default(),
    )?;
    let jobs = state
        .exports
        .lock()
        .map_err(|_| "export jobs unavailable".to_string())?;
    let job = jobs
        .get(&job_id)
        .ok_or_else(|| "unknown export job".to_string())?;
    let mut value = job.progress.snapshot();
    value["job"] = Value::String(job_id);
    Ok(value)
}

#[cfg(target_os = "android")]
pub(crate) fn export_transfer(state: &ServerState, payload: &Value) -> Result<Value, String> {
    let scope = ExportScope::parse(
        payload
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("all"),
    )?;
    let request_id = crate::paths::sanitize_id(
        payload
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Android export requestId is required".to_string())?,
    )?;
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("wordhunter-transfer.zip");
    let cache = state
        .app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("wordhunter-transfer");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let path = cache.join(format!("{request_id}.zip"));
    let summary = state.store.export_transfer(&path, scope, None)?;
    Ok(serde_json::json!({
        "saved": true,
        "path": path,
        "filename": filename,
        "summary": summary,
    }))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn import_transfer(state: &ServerState, _payload: &Value) -> Result<Value, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("WordHunter package", &["zip"])
        .pick_file()
    else {
        return Ok(serde_json::json!({ "imported": false }));
    };
    validate_import_package(&path, crate::store::transfer::MAX_TOTAL_BYTES)?;
    let summary = state.store.import_transfer(&path)?;
    Ok(serde_json::json!({ "imported": true, "summary": summary }))
}

/// Rejects picked import files that are not `.zip` archives or exceed the
/// transfer package size cap (2 GiB, same as transfer.rs MAX_TOTAL_BYTES),
/// so a giant or foreign file is refused before the archive is opened.
#[cfg(not(target_os = "android"))]
pub(crate) fn validate_import_package(path: &Path, max_bytes: u64) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("zip") {
        return Err("import file must be a .zip archive".to_string());
    }
    let len = std::fs::metadata(path)
        .map_err(|error| format!("could not read import file metadata: {error}"))?
        .len();
    if len > max_bytes {
        return Err("import archive exceeds the maximum supported size".to_string());
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub(crate) fn import_transfer(state: &ServerState, payload: &Value) -> Result<Value, String> {
    let source = PathBuf::from(
        payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "Android import path is required".to_string())?,
    );
    let cache = state
        .app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("wordhunter-transfer");
    let cache = std::fs::canonicalize(&cache)
        .map_err(|_| "Android transfer cache is unavailable".to_string())?;
    let source = std::fs::canonicalize(&source)
        .map_err(|_| "Android import file is unavailable".to_string())?;
    if !source.starts_with(&cache)
        || source.extension().and_then(|value| value.to_str()) != Some("zip")
    {
        return Err("Android import path is invalid".to_string());
    }
    let result = state.store.import_transfer(&source);
    let cleanup = crate::store::durable::remove_file_if_exists(&source);
    match (result, cleanup) {
        (Ok(summary), Ok(())) => Ok(serde_json::json!({ "imported": true, "summary": summary })),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(format!(
            "import succeeded but temporary file cleanup failed: {error}"
        )),
    }
}

#[cfg(not(target_os = "android"))]
fn install_export_temp(path: &Path, temp: &Path) -> Result<(), String> {
    let backup = export_sidecar_path(path, ".wordhunter-export.bak")?;
    if !path.exists() {
        std::fs::rename(temp, path)
            .map_err(|e| format!("could not install export {}: {e}", path.display()))?;
        return crate::store::durable::sync_parent(path);
    }
    crate::store::durable::remove_file_if_exists(&backup)?;
    std::fs::rename(path, &backup)
        .map_err(|e| format!("could not stage previous export {}: {e}", path.display()))?;
    if let Err(error) = std::fs::rename(temp, path) {
        let restore = std::fs::rename(&backup, path);
        return Err(format!(
            "could not install export {error}; restore: {restore:?}"
        ));
    }
    crate::store::durable::remove_file_if_exists(&backup)?;
    crate::store::durable::sync_parent(path)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn choose_data_dir(state: &ServerState) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Choose WordHunter local data folder")
        .set_directory(state.store.dir())
        .pick_folder()
    else {
        return Ok(None);
    };
    let _ocr_guard = state
        .ocr_slot
        .try_lock()
        .map_err(|_| "Cannot move the data folder while an OCR import is running".to_string())?;
    let path = state.store.relocate(path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(target_os = "android")]
pub(crate) fn choose_data_dir(_state: &ServerState) -> Result<Option<String>, String> {
    Err("Changing the local data folder is not supported on Android".to_string())
}

#[cfg(test)]
mod window_zoom_tests {
    use serde_json::json;

    use super::parse_window_zoom_percent;
    use super::validate_external_url;
    #[cfg(not(target_os = "android"))]
    use super::{
        export_sidecar_path, validate_export_filename, validate_import_package, write_export_file,
    };

    #[test]
    fn accepts_supported_window_zoom_and_rejects_invalid_values() {
        assert_eq!(
            parse_window_zoom_percent(&json!({ "percent": 80 })).unwrap(),
            0.8
        );
        assert_eq!(
            parse_window_zoom_percent(&json!({ "percent": 100 })).unwrap(),
            1.0
        );
        assert_eq!(
            parse_window_zoom_percent(&json!({ "percent": 150 })).unwrap(),
            1.5
        );
        assert!(parse_window_zoom_percent(&json!({ "percent": 79 })).is_err());
        assert!(parse_window_zoom_percent(&json!({ "percent": 151 })).is_err());
        assert!(parse_window_zoom_percent(&json!({ "percent": 100.5 })).is_err());
        assert!(parse_window_zoom_percent(&json!({})).is_err());
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn failed_export_replace_keeps_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("backup.json");
        std::fs::write(&target, "previous backup").unwrap();
        std::fs::create_dir(export_sidecar_path(&target, ".wordhunter-export.bak").unwrap())
            .unwrap();

        assert!(write_export_file(&target, "new backup").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "previous backup");
    }

    #[test]
    fn open_external_url_rejects_non_http_and_empty() {
        // Pure validation — no browser is spawned by these assertions.
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("file:///C:/Windows/win.ini").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("not a url").is_err());
        assert!(validate_external_url("http://").is_err()); // no host
        assert!(validate_external_url("https://exa\nmple.com").is_err()); // control char
        // Command-injection regression: metacharacters are inert because the
        // URL is never passed to a shell (open::that_detached/ShellExecuteExW).
        // They must either be rejected or opened verbatim — never executed.
        assert!(validate_external_url("https://example.com/a&calc.exe").is_ok());
        assert!(validate_external_url("https://example.com/a|cmd").is_ok());
        assert!(
            validate_external_url("https://example.com/a%22%20&%20calc.exe%20&%20REM%20%22")
                .is_ok()
        );
        assert!(validate_external_url("https://youglish.com/pronounce/klima/german").is_ok());
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn export_filename_validation_rejects_paths_and_empty_names() {
        assert!(validate_export_filename("export.txt").is_ok());
        assert!(validate_export_filename("wordhunter-transfer.zip").is_ok());
        assert!(validate_export_filename("").is_err());
        assert!(validate_export_filename("..").is_err());
        assert!(validate_export_filename("a/b.txt").is_err());
        assert!(validate_export_filename("a\\b.txt").is_err());
        assert!(validate_export_filename(&"x".repeat(256)).is_err());
        assert!(validate_export_filename(&"x".repeat(255)).is_ok());
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn import_package_validation_requires_zip_and_respects_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str| {
            let path = dir.path().join(name);
            // Each file is written directly: on Windows, copying a freshly
            // written file can hit the Defender scan lock (os error 32),
            // which would make the test flaky.
            std::fs::write(&path, "not a real zip; the check is extension + size").unwrap();
            path
        };
        let zip = write("backup.zip");
        assert!(validate_import_package(&zip, 1024).is_ok());
        let upper = write("BACKUP.ZIP");
        assert!(validate_import_package(&upper, 1024).is_ok());
        let txt = write("backup.txt");
        assert!(validate_import_package(&txt, 1024).is_err());
        let bare = write("backup");
        assert!(validate_import_package(&bare, 1024).is_err());
        assert!(validate_import_package(&zip, 10).is_err());
        assert!(validate_import_package(&zip, u64::MAX).is_ok());
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn export_sidecars_never_collide_with_tmp_or_bak_destinations() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["backup.tmp", "backup.bak"] {
            let target = dir.path().join(name);
            std::fs::write(&target, "previous backup").unwrap();
            write_export_file(&target, "new backup").unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "new backup");
            assert!(
                !export_sidecar_path(&target, ".wordhunter-export.tmp")
                    .unwrap()
                    .exists()
            );
            assert!(
                !export_sidecar_path(&target, ".wordhunter-export.bak")
                    .unwrap()
                    .exists()
            );
        }
    }
}
