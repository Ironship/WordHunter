use tiny_http::Request;
use tauri::{AppHandle, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::response;

const INTERNAL_POPUP_LABEL: &str = "internal-popup";

fn popup_escape_script(base_url: &str) -> String {
    format!(
        "document.addEventListener('keydown',e=>{{if(e.key==='Escape'){{e.preventDefault();new Image().src='{base_url}/__popup/close';}}}},true);"
    )
}

/// Handle `/__open_dict` — open a URL in an external browser or an internal popup window.
///
/// * `mode=internal` — open a centered 900×700 webview popup
/// * `mode=external` (default) — open in the system browser
pub fn serve_open_dict(
    request: Request,
    base_url: &str,
    app_handle: &AppHandle,
    query: &str,
) -> Result<(), String> {
    let params = response::parse_query(query);
    if let Some(url) = params.get("url") {
        let target = if url.starts_with('/') {
            format!("{base_url}{url}")
        } else {
            url.to_string()
        };
        let mode = params
            .get("mode")
            .map(String::as_str)
            .unwrap_or("external");
        let title = params
            .get("title")
            .cloned()
            .unwrap_or_else(|| "Word Hunter".to_string());
        if mode == "internal" {
            let handle = app_handle.clone();
            let target_for_nav = target.clone();
            let popup_script = popup_escape_script(base_url);
            let _ = handle.clone().run_on_main_thread(move || {
                let center = handle.get_webview_window("main").and_then(|main| {
                    let pos = main.outer_position().ok()?;
                    let size = main.outer_size().ok()?;
                    Some((
                        pos.x + (size.width as i32 - 900) / 2,
                        pos.y + (size.height as i32 - 700) / 2,
                    ))
                });

                if let Some(existing) = handle.get_webview_window(INTERNAL_POPUP_LABEL) {
                    let _ = existing.set_title(&title);
                    let _ = existing.unminimize();
                    if let Ok(parsed) = Url::parse(&target_for_nav) {
                        if let Err(err) = existing.navigate(parsed) {
                            eprintln!("popup navigate failed: {err}");
                        }
                    }
                    if let Some((x, y)) = center {
                        let _ = existing.set_position(Position::Physical(PhysicalPosition { x, y }));
                    }
                    if let Err(err) = existing.set_focus() {
                        eprintln!("popup focus failed: {err}");
                    }
                    return;
                }
                let parsed = match Url::parse(&target) {
                    Ok(url) => url,
                    Err(err) => {
                        eprintln!("popup url parse failed: {err}");
                        return;
                    }
                };
                match WebviewWindowBuilder::new(
                    &handle,
                    INTERNAL_POPUP_LABEL,
                    WebviewUrl::External(parsed),
                )
                .title(&title)
                .inner_size(900.0, 700.0)
                .initialization_script(popup_script)
                .build()
                {
                    Ok(window) => {
                        if let Some((x, y)) = center {
                            let _ = window
                                .set_position(Position::Physical(PhysicalPosition { x, y }));
                        }
                        if let Err(err) = window.set_focus() {
                            eprintln!("popup focus failed: {err}");
                        }
                    }
                    Err(err) => eprintln!("popup window build failed: {err}"),
                }
            });
        } else {
            let _ = open::that(target);
        }
    }
    response::no_content(request)
}

pub fn serve_close_popup(request: Request, app_handle: &AppHandle) -> Result<(), String> {
    let handle = app_handle.clone();
    let _ = handle.clone().run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(INTERNAL_POPUP_LABEL) {
            let _ = window.close();
        }
    });
    response::no_content(request)
}

#[cfg(test)]
mod tests {
    use super::popup_escape_script;

    #[test]
    fn escape_script_targets_the_local_popup_close_route() {
        let script = popup_escape_script("http://127.0.0.1:1234");
        assert!(script.contains("Escape"));
        assert!(script.contains("http://127.0.0.1:1234/__popup/close"));
    }
}
