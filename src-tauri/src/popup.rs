use tauri::{AppHandle, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder};
use tiny_http::Request;
use url::Url;

use crate::response;

const INTERNAL_POPUP_LABEL: &str = "internal-popup";

fn popup_close_url(base_url: &str) -> String {
    format!("{base_url}/__popup/close")
}

fn popup_escape_script(base_url: &str) -> String {
    let close_url = popup_close_url(base_url);
    format!(
        "window.addEventListener('keydown',e=>{{if(e.key==='Escape'){{e.preventDefault();e.stopImmediatePropagation();window.location.replace('{close_url}');}}}},true);"
    )
}

/// Reject anything but http(s) targets for the OS/webview open paths.
fn validated_open_target(target: &str) -> Result<String, String> {
    let target = target.trim();
    if !(target.starts_with("https://") || target.starts_with("http://")) {
        return Err("refusing to open a non-http URL".to_string());
    }
    Ok(target.to_string())
}

fn is_popup_close_navigation(url: &Url, close_url: &str) -> bool {
    url.as_str() == close_url
}

fn queue_internal_popup_close(app_handle: &AppHandle) {
    let handle = app_handle.clone();
    let _ = handle.clone().run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(INTERNAL_POPUP_LABEL) {
            let _ = window.close();
        }
    });
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
        // Only http(s) targets may reach the OS browser or the
        // webview: file:/custom-protocol URLs must never be handed
        // out (audit #93). The internal popup legitimately shows
        // third-party https pages (Youglish), so no host restriction.
        let target = match validated_open_target(&target) {
            Ok(ok) => ok,
            Err(err) => return Err(err),
        };
        let mode = params.get("mode").map(String::as_str).unwrap_or("external");
        let title = params
            .get("title")
            .cloned()
            .unwrap_or_else(|| "Word Hunter".to_string());
        if mode == "internal" {
            let handle = app_handle.clone();
            let target_for_nav = target.clone();
            let popup_script = popup_escape_script(base_url);
            let close_url = popup_close_url(base_url);
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
                    if let Ok(parsed) = Url::parse(&target_for_nav)
                        && let Err(err) = existing.navigate(parsed)
                    {
                        eprintln!("popup navigate failed: {err}");
                    }
                    if let Some((x, y)) = center {
                        let _ =
                            existing.set_position(Position::Physical(PhysicalPosition { x, y }));
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
                let navigation_handle = handle.clone();
                match WebviewWindowBuilder::new(
                    &handle,
                    INTERNAL_POPUP_LABEL,
                    WebviewUrl::External(parsed),
                )
                .title(&title)
                .inner_size(900.0, 700.0)
                .initialization_script(popup_script)
                .on_navigation(move |url| {
                    if is_popup_close_navigation(url, &close_url) {
                        queue_internal_popup_close(&navigation_handle);
                        false
                    } else {
                        true
                    }
                })
                .build()
                {
                    Ok(window) => {
                        if let Some((x, y)) = center {
                            let _ =
                                window.set_position(Position::Physical(PhysicalPosition { x, y }));
                        }
                        if let Err(err) = window.set_focus() {
                            eprintln!("popup focus failed: {err}");
                        }
                    }
                    Err(err) => eprintln!("popup window build failed: {err}"),
                }
            });
        } else {
            crate::handlers::open_external_url(&target)?;
        }
    }
    response::no_content(request)
}

pub fn serve_close_popup(request: Request, app_handle: &AppHandle) -> Result<(), String> {
    queue_internal_popup_close(app_handle);
    response::no_content(request)
}

#[cfg(test)]
mod tests {
    use super::{is_popup_close_navigation, popup_escape_script, validated_open_target};
    use url::Url;

    #[test]
    fn open_target_rejects_non_http_schemes() {
        assert!(validated_open_target("file:///etc/passwd").is_err());
        assert!(validated_open_target("javascript:alert(1)").is_err());
        assert!(validated_open_target("custom-protocol://payload").is_err());
        assert!(validated_open_target("").is_err());
    }

    #[test]
    fn open_target_accepts_http_and_https() {
        assert_eq!(
            validated_open_target("https://youglish.com/pronounce/word"),
            Ok("https://youglish.com/pronounce/word".to_string())
        );
        assert!(validated_open_target("http://127.0.0.1:38619/index.html").is_ok());
    }

    #[test]
    fn escape_script_uses_navigation_instead_of_a_cross_site_request() {
        let script = popup_escape_script("http://127.0.0.1:1234");
        assert!(script.contains("Escape"));
        assert!(script.contains("http://127.0.0.1:1234/__popup/close"));
        assert!(script.contains("window.location.replace"));
        assert!(!script.contains("new Image"));
    }

    #[test]
    fn popup_close_navigation_requires_the_exact_sentinel_url() {
        let close_url = "http://127.0.0.1:1234/__popup/close";
        assert!(is_popup_close_navigation(
            &Url::parse(close_url).unwrap(),
            close_url
        ));
        assert!(!is_popup_close_navigation(
            &Url::parse("https://dict.example/word").unwrap(),
            close_url
        ));
        assert!(!is_popup_close_navigation(
            &Url::parse("http://127.0.0.1:1234/__popup/close?next=1").unwrap(),
            close_url
        ));
    }
}
