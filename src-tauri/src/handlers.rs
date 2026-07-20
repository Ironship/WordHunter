use serde_json::Value;
#[cfg(target_os = "android")]
use serde_json::json;
use std::path::{Component, Path};
use std::{fs, path::PathBuf};
use tauri::Manager;
use tiny_http::Request;

use crate::{offline_translator, response, server::ServerState, tts};

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
    let snapshot = state.store.snapshot_with_ui_state();
    let bootstrap = bootstrap_script(&state.token, Some(&snapshot));
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

pub(crate) fn bootstrap_script(token: &str, snapshot: Option<&Value>) -> String {
    let escaped = escape_inline_json(&Value::String(token.to_string()));
    let snapshot = snapshot
        .map(escape_inline_json)
        .unwrap_or_else(|| "null".to_string());
    format!(
        r#"
(function() {{
  window.__qtBridge = true;
  window.WH_TOKEN = {escaped};
  const bridgeSnapshot = {snapshot};
  if (bridgeSnapshot !== null) window.__bridgeState = bridgeSnapshot;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {{
    try {{
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (/^https?:\/\/(www\.)?gutenberg\.org\//i.test(url)) {{
        const proxied = '/__proxy?url=' + encodeURIComponent(url);
        if (typeof input === 'string') return origFetch(proxied, init);
        return origFetch(new Request(proxied, input), init);
      }}
    }} catch (e) {{}}
    return origFetch(input, init);
  }};
}})();
"#
    )
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
    response::respond(request, 200, file.contents().to_vec(), &mime, false)
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
    let params = response::parse_query(query);
    let book = params.get("book").cloned().unwrap_or_default();
    let img = params.get("img").cloned().unwrap_or_default();
    let file_path = state.store.book_image_path(&book, &img)?;
    if !file_path.is_file() {
        return response::error_response(request, 404, "not found");
    }
    let data = fs::read(&file_path).map_err(|e| e.to_string())?;
    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    response::respond(request, 200, data, &mime, true)
}

pub(crate) fn serve_edge_tts(request: Request, query: &str) -> Result<(), String> {
    let params = response::parse_query(query);
    let text = params.get("text").cloned().unwrap_or_default();
    let lang = params
        .get("lang")
        .cloned()
        .unwrap_or_else(|| "pl".to_string());
    let rate = params.get("rate").map(String::as_str).unwrap_or("normal");
    if text.trim().is_empty() {
        return response::error_response(request, 400, "TTS text is empty");
    }

    match tts::synthesize(&text, &lang, rate) {
        Ok(result) => {
            let timings = result
                .boundaries
                .iter()
                .map(|event| (event.offset_ticks / 10_000).to_string())
                .collect::<Vec<_>>()
                .join(",");
            response::respond_with_headers(
                request,
                200,
                result.audio,
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
    if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() {
        write_export_file(&path, data)?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(not(target_os = "android"))]
fn write_export_file(path: &std::path::Path, data: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = export_sidecar_path(path, ".wordhunter-export.tmp")?;
    let backup = export_sidecar_path(path, ".wordhunter-export.bak")?;
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
    if !path.exists() {
        std::fs::rename(&temp, path)
            .map_err(|e| format!("could not install export {}: {e}", path.display()))?;
        return crate::store::durable::sync_parent(path);
    }

    crate::store::durable::remove_file_if_exists(&backup)?;
    std::fs::rename(path, &backup)
        .map_err(|e| format!("could not stage previous export {}: {e}", path.display()))?;
    if let Err(install_error) = std::fs::rename(&temp, path) {
        let restore = std::fs::rename(&backup, path);
        return match restore {
            Ok(()) => Err(format!(
                "could not replace export {}; previous file was restored: {install_error}",
                path.display()
            )),
            Err(restore_error) => Err(format!(
                "could not replace export {} ({install_error}) or restore its backup ({restore_error})",
                path.display()
            )),
        };
    }
    crate::store::durable::remove_file_if_exists(&backup)?;
    crate::store::durable::sync_parent(path)
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
        .map_err(|_| "Cannot move the data folder while a PDF import is running".to_string())?;
    let path = state.store.relocate(path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(target_os = "android")]
pub(crate) fn choose_data_dir(_state: &ServerState) -> Result<Option<String>, String> {
    Err("Sync folder picker needs Android Storage Access Framework wiring".to_string())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn choose_sync_dir(state: &ServerState) -> Result<Option<(String, Value)>, String> {
    let start = crate::paths::sync_dir(crate::APP_NAME)
        .ok()
        .flatten()
        .unwrap_or_else(|| state.store.dir());
    let Some(path) = rfd::FileDialog::new()
        .set_title("Choose WordHunter sync folder")
        .set_directory(start)
        .pick_folder()
    else {
        return Ok(None);
    };
    let mut snapshot = state.store.sync_with_directory(path.clone())?;
    crate::paths::set_sync_dir(crate::APP_NAME, &path)?;
    state.syncthing.configure_folder_if_running(&path)?;
    let path = path.to_string_lossy().into_owned();
    snapshot["syncDir"] = Value::String(path.clone());
    Ok(Some((path, snapshot)))
}

#[cfg(target_os = "android")]
pub(crate) fn choose_sync_dir(_state: &ServerState) -> Result<Option<(String, Value)>, String> {
    Err("Sync folder picker is handled by the Android bridge".to_string())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn prepare_sync_dir(state: &ServerState) -> Result<Value, String> {
    let dir = crate::sync_assistant::managed_sync_dir()?;
    let mut snapshot = state.store.sync_with_directory(dir.clone())?;
    crate::paths::set_sync_dir(crate::APP_NAME, &dir)?;
    state.syncthing.configure_folder_if_running(&dir)?;
    let path = dir.to_string_lossy().into_owned();
    snapshot["syncDir"] = Value::String(path.clone());
    Ok(serde_json::json!({
        "path": path,
        "snapshot": snapshot,
        "health": crate::sync_assistant::folder_health(&dir),
    }))
}

#[cfg(target_os = "android")]
pub(crate) fn prepare_sync_dir(_state: &ServerState) -> Result<Value, String> {
    Err("Sync folder setup is handled by the Android bridge".to_string())
}

pub(crate) fn sync_health() -> Value {
    crate::sync_assistant::configured_sync_health()
}

pub(crate) fn syncthing_status(state: &ServerState) -> Value {
    state.syncthing.status()
}

pub(crate) fn syncthing_start(state: &ServerState) -> Result<Value, String> {
    state.syncthing.start()
}

pub(crate) fn syncthing_stop(state: &ServerState) -> Result<Value, String> {
    state.syncthing.stop()
}

pub(crate) fn syncthing_device_qr(state: &ServerState) -> Result<String, String> {
    state.syncthing.device_qr_svg()
}

pub(crate) fn syncthing_pair(
    state: &ServerState,
    device_id: &str,
    device_name: &str,
) -> Result<Value, String> {
    state.syncthing.pair_device(device_id, device_name)
}

pub(crate) fn sync_now(state: &ServerState) -> Result<Value, String> {
    let dir = crate::paths::sync_dir(crate::APP_NAME)?
        .ok_or_else(|| "sync folder is not configured".to_string())?;
    state.store.sync_with_directory(dir)
}

#[cfg(target_os = "android")]
pub(crate) fn sync_android_staging(state: &ServerState, payload: &Value) -> Result<Value, String> {
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Android sync requestId is required".to_string())?;
    let request_id = crate::paths::sanitize_id(request_id)?;
    let cache_dir = state
        .app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let staging_parent = cache_dir.join("wordhunter-sync-staging");
    let staging_root = staging_parent.join(request_id);
    let incoming_dir = staging_root.join("incoming");

    let staging_parent = std::fs::canonicalize(&staging_parent)
        .map_err(|_| "Android sync staging parent is unavailable".to_string())?;
    let staging_root = std::fs::canonicalize(&staging_root)
        .map_err(|_| "Android sync staging folder is unavailable".to_string())?;
    let incoming_dir = std::fs::canonicalize(&incoming_dir)
        .map_err(|_| "Android sync input folder is unavailable".to_string())?;
    if !staging_root.starts_with(&staging_parent) || !incoming_dir.starts_with(&staging_root) {
        return Err("Android sync staging path is invalid".to_string());
    }

    state.store.recover_pending_save_guarded()?;
    let local_dir = state.store.dir();
    state.store.sync_with_directory(incoming_dir.clone())?;
    Ok(json!({
        "status": "synced",
        "health": {
            "staging": crate::sync_assistant::folder_health(&incoming_dir),
            "local": crate::sync_assistant::folder_health(&local_dir),
        }
    }))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn sync_android_staging(
    _state: &ServerState,
    _payload: &Value,
) -> Result<Value, String> {
    Err("Android staged sync is only available on Word Hunter Pocket".to_string())
}

#[cfg(test)]
mod window_zoom_tests {
    use serde_json::json;

    use super::parse_window_zoom_percent;
    #[cfg(not(target_os = "android"))]
    use super::{export_sidecar_path, write_export_file};

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
