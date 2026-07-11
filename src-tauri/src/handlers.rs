use serde_json::Value;
#[cfg(target_os = "android")]
use serde_json::json;
use std::path::{Component, Path};
use std::{fs, path::PathBuf};
#[cfg(target_os = "android")]
use tauri::Manager;
use tiny_http::Request;

use crate::{offline_translator, response, server::ServerState, tts};

pub(crate) fn serve_index(request: Request, state: &ServerState) -> Result<(), String> {
    let index = crate::router::WEB_ASSETS
        .get_file("index.html")
        .ok_or_else(|| "embedded index.html was not found".to_string())?;
    let mut html = String::from_utf8(index.contents().to_vec()).map_err(|e| e.to_string())?;
    let snapshot = state.store.snapshot();
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
    if text.trim().is_empty() {
        return response::error_response(request, 400, "TTS text is empty");
    }

    match tts::synthesize(&text, &lang) {
        Ok(audio) => response::respond(request, 200, audio, "audio/mpeg", false),
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
        fs::write(path, data).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
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
