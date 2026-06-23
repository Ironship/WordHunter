use serde_json::Value;
use std::path::{Component, Path};
use std::{fs, path::PathBuf};
use tiny_http::Request;

use crate::{offline_translator, response, server::ServerState, tts};

pub(crate) fn serve_index(request: Request, state: &ServerState) -> Result<(), String> {
    let index = crate::router::WEB_ASSETS
        .get_file("index.html")
        .ok_or_else(|| "embedded index.html was not found".to_string())?;
    let mut html = String::from_utf8(index.contents().to_vec()).map_err(|e| e.to_string())?;
    let bootstrap = bootstrap_script(&state.token);
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

pub(crate) fn bootstrap_script(token: &str) -> String {
    // Escape the token so it is safe to embed inside a double-quoted JS string within
    // a <script> block. The token is currently alphanumeric, but this guards against
    // future changes and DOM-based XSS via `"</script>"` or quote injection.
    let escaped = token
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace("</", "<\\/");
    format!(
        r#"
(function() {{
  window.__qtBridge = true;
  window.WH_TOKEN = "{escaped}";
  try {{
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/__store/load', false);
    xhr.send(null);
    if (xhr.status === 200) {{
      window.__bridgeState = JSON.parse(xhr.responseText);
    }}
  }} catch (e) {{ console.warn('bridge preload failed', e); }}
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

pub(crate) fn serve_static(
    request: Request,
    _state: &ServerState,
    path: &str,
) -> Result<(), String> {
    let relative = sanitize_relative_path(path.trim_start_matches('/'))?;
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

pub(crate) fn save_export(payload: Value) -> Result<(), String> {
    let data = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("export.txt");
    if let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() {
        fs::write(path, data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn choose_data_dir(state: &ServerState) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_directory(state.store.dir())
        .pick_folder()
    else {
        return Ok(None);
    };
    let path = state.store.relocate(path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
