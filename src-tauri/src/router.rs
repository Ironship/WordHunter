use base64::Engine;
use include_dir::{Dir, include_dir};
use serde_json::{Value, json};
use std::sync::Arc;
use tiny_http::{Method, Request};

use crate::{
    ai_explainer, ebook, external_translator, handlers, offline_translator, pdf_ocr, popup, proxy,
    response,
    server::{ActiveOcrJob, ServerState},
    srs, update, vocab_export, vocab_index, youtube_captions,
};

pub(crate) static WEB_ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist/web");

macro_rules! read_json_or_400 {
    ($request:ident) => {
        match response::read_json_limited(&mut $request, MAX_JSON_REQUEST_BODY) {
            Ok(payload) => payload,
            Err(error) => {
                let status = if error.contains("too large") {
                    413
                } else {
                    400
                };
                return response::error_response(
                    $request,
                    status,
                    &format!("invalid JSON body: {error}"),
                );
            }
        }
    };
}

macro_rules! read_json_limited_or_error {
    ($request:ident, $max_bytes:expr) => {
        match response::read_json_limited(&mut $request, $max_bytes) {
            Ok(payload) => payload,
            Err(error) => {
                let status = if error.contains("too large") {
                    413
                } else {
                    400
                };
                return response::error_response($request, status, &error);
            }
        }
    };
}

const MAX_IMPORT_REQUEST_BODY: usize = 384 * 1024 * 1024;
const MAX_RAW_PDF_BODY: usize = 400 * 1024 * 1024;
const MAX_RAW_OCR_IMAGE_BODY: usize = 32 * 1024 * 1024;
const MAX_IMAGE_REQUEST_BODY: usize = 32 * 1024 * 1024;
const MAX_COMMAND_REQUEST_BODY: usize = 8 * 1024;
const MAX_UI_STATE_REQUEST_BODY: usize = 2 * 1024 * 1024;
const MAX_JSON_REQUEST_BODY: usize = 128 * 1024 * 1024;
const MAX_LOG_BODY: usize = 8 * 1024;

fn validate_book_image_payload(payload: &Value) -> Result<(), String> {
    let book_id = payload
        .get("book_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "book_id required".to_string())?;
    let img_name = payload
        .get("img_name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "img_name required".to_string())?;
    let data_url = payload
        .get("base64_data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "base64_data required".to_string())?;
    crate::paths::sanitize_id(book_id)?;
    crate::paths::sanitize_id(img_name)?;
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "base64_data is invalid".to_string())?;
    Ok(())
}

fn request_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn method_not_allowed(method: &Method, path: &str) -> bool {
    let allows_get = matches!(
        path,
        "/" | "/index.html"
            | "/__proxy"
            | "/__store/load"
            | "/__store/export_progress"
            | "/__update/check"
            | "/__book/text"
            | "/__book/pdf_pages"
            | "/__media"
            | "/__open_dict"
            | "/__open_external"
            | "/__popup/close"
            | "/__argos/status"
            | "/__ocr/gpu-status"
            | "/__argos/packages"
            | "/__argos/translate"
            | "/__argos/ui"
            | "/__tts"
    );
    let allows_post = matches!(
        path,
        "/__log_error"
            | "/__app/close"
            | "/__window/zoom"
            | "/__store/save"
            | "/__store/ui_state"
            | "/__store/ack_snapshot"
            | "/__store/choose_data_dir"
            | "/__store/export_transfer"
            | "/__store/import_transfer"
            | "/__store/upsert_text"
            | "/__store/delete_text"
            | "/__store/wipe"
            | "/__book/image"
            | "/__export/save"
            | "/__import/ebook"
            | "/__import/pdf_ocr/raw"
            | "/__import/image_ocr/raw"
            | "/__import/ocr/cancel"
            | "/__import/pdf_ocr/cancel"
            | "/__argos/install"
            | "/__srs/review"
            | "/__translate/external"
            | "/__ai/explain"
            | "/__ai/explain_stream"
            | "/__text/vocab_index"
            | "/__youtube/captions"
            | "/__vocab"
    );
    (allows_get || allows_post)
        && !((allows_get && method == &Method::Get) || (allows_post && method == &Method::Post))
}

pub(crate) fn valid_request_source(request: &Request, base_url: &str) -> bool {
    let expected_host = base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
        .unwrap_or(base_url);
    if request_header(request, "Host") != Some(expected_host) {
        return false;
    }
    if request_header(request, "Sec-Fetch-Site")
        .is_some_and(|value| value.eq_ignore_ascii_case("cross-site"))
    {
        return false;
    }
    // A same-origin fetch carries no Origin header; the app's own pages
    // never send "null". file:///data: embeds and sandboxed frames do —
    // they may issue read-only GETs, but never authenticated writes.
    match request_header(request, "Origin") {
        None => true,
        Some(origin) if origin == base_url => true,
        Some("null") => request.method() != &Method::Post,
        Some(_) => false,
    }
}

fn authenticate_request(
    request: Request,
    path: &str,
    token: &str,
) -> Result<Option<Request>, String> {
    let requires_token = request.method() == &Method::Post && path != "/__log_error"
        || request.method() == &Method::Get && sensitive_get_path(path);
    if requires_token && !response::valid_token(&request, token) {
        response::error_response(request, 403, "forbidden")?;
        return Ok(None);
    }
    Ok(Some(request))
}

/// GET endpoints that expose stored user data and must not be reachable by
/// other local processes on a shared loopback (Android uses a fixed port).
fn sensitive_get_path(path: &str) -> bool {
    path.starts_with("/__store/") || path.starts_with("/__book/")
}

fn dispatch_state_independent_request(
    request: Request,
    path: &str,
    query: &str,
) -> Result<Option<Request>, String> {
    match (request.method(), path) {
        (&Method::Get, "/__proxy") => {
            proxy::serve_proxy(request, query)?;
            Ok(None)
        }
        _ => Ok(Some(request)),
    }
}

/// Returns true only when the payload carries an explicit `confirm: true`.
///
/// Native file dialogs and destructive store actions (fix #110) must never
/// be unlocked by a missing, false, null, or non-boolean `confirm` value —
/// the frontend sends it only after the user initiated the action in the UI.
pub(crate) fn confirm_requested(payload: &Value) -> bool {
    payload
        .get("confirm")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Consumes `request` with a 400 response when the payload does not carry
/// `confirm: true`; otherwise returns the request for the handler to use.
fn confirm_or_400(request: Request, payload: &Value) -> Option<Request> {
    if confirm_requested(payload) {
        Some(request)
    } else {
        let _ = response::error_response(request, 400, "user confirmation required");
        None
    }
}

/// Main request dispatcher.
pub fn handle_request(request: Request, state: Arc<ServerState>) -> Result<(), String> {
    let method = request.method().clone();
    let full_url = request.url().to_string();
    let (path, query) = response::split_url(&full_url);
    if !valid_request_source(&request, &state.base_url) {
        return response::error_response(request, 403, "forbidden request source");
    }
    if method_not_allowed(request.method(), path) {
        return response::error_response(request, 405, "method not allowed");
    }
    let Some(request) = authenticate_request(request, path, &state.token)? else {
        return Ok(());
    };
    let Some(mut request) = dispatch_state_independent_request(request, path, query)? else {
        return Ok(());
    };

    match (method, path) {
        (Method::Get, "/") | (Method::Get, "/index.html") => handlers::serve_index(request, &state),
        (Method::Get, "/__store/load") => {
            let mut snapshot = if response::query_value(query, "ack").as_deref() == Some("0") {
                state.store.snapshot_unacknowledged()
            } else {
                state.store.snapshot()
            };
            if let Some(object) = snapshot.as_object_mut() {
                object.insert("uiState".to_string(), state.store.load_ui_state());
            }
            response::json_response(request, snapshot)
        }
        #[cfg(not(target_os = "android"))]
        (Method::Get, "/__store/export_progress") => {
            match handlers::export_progress(&state, query) {
                Ok(result) => response::json_response(request, result),
                Err(error) => response::error_response(request, 404, &error),
            }
        }
        (Method::Get, "/__update/check") => response::json_response(
            request,
            update::check(proxy::USER_AGENT, crate::APP_VERSION),
        ),
        (Method::Get, "/__book/text") => {
            let params = response::parse_query(query);
            let id = params.get("id").cloned().unwrap_or_default();
            match state.store.get_text_content(&id) {
                Ok(text) => response::json_response(request, json!({ "text": text })),
                Err(error) => response::error_response(request, 404, &error),
            }
        }
        (Method::Get, "/__book/pdf_pages") => {
            let params = response::parse_query(query);
            let id = params.get("id").cloned().unwrap_or_default();
            match state.store.get_pdf_ocr_pages(&id) {
                Ok(pages) => response::json_response(request, json!({ "pages": pages })),
                Err(error) => response::error_response(request, 404, &error),
            }
        }
        (Method::Get, "/__media") => handlers::serve_media(request, &state, query),
        (Method::Get, "/__open_dict") => {
            popup::serve_open_dict(request, &state.base_url, &state.app_handle, query)
        }
        (Method::Get, "/__open_external") => {
            let url = response::parse_query(query)
                .get("url")
                .cloned()
                .unwrap_or_default();
            match handlers::open_external_url(&url) {
                Ok(()) => response::no_content(request),
                Err(error) => response::error_response(request, 400, &error),
            }
        }
        (Method::Get, "/__popup/close") => popup::serve_close_popup(request, &state.app_handle),
        (Method::Get, "/__argos/status") => {
            response::json_response(request, offline_translator::status())
        }
        (Method::Get, "/__ocr/gpu-status") => {
            response::json_response(request, pdf_ocr::gpu_status(&state.app_handle))
        }
        (Method::Get, "/__argos/packages") => match offline_translator::packages() {
            Ok(payload) => response::json_response(request, payload),
            Err(_) => response::error_response(request, 500, "offline package listing failed"),
        },
        (Method::Get, "/__argos/translate") => match offline_translator::translate(query) {
            Ok(payload) => response::json_response(request, payload),
            Err(err) if err.starts_with("invalid request:") => {
                response::error_response(request, 400, &err)
            }
            Err(_) => response::error_response(request, 500, "offline translation failed"),
        },
        (Method::Get, "/__argos/ui") => handlers::serve_offline_translator_ui(request, query),
        (Method::Get, "/__tts") => handlers::serve_edge_tts(request, query),
        (Method::Get, _) => handlers::serve_static(request, path),
        (Method::Post, "/__log_error") => {
            let body = match response::read_body_limited(&mut request, MAX_LOG_BODY) {
                Ok(body) => body,
                Err(error) => return response::error_response(request, 413, &error),
            };
            let text = String::from_utf8_lossy(&body);
            eprintln!("{text}");
            response::no_content(request)
        }
        (Method::Post, _) => match path {
            "/__app/close" => {
                let _payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                response::no_content(request)?;
                crate::platform::permit_exit(&state.app_handle);
                state.app_handle.exit(0);
                Ok(())
            }
            "/__window/zoom" => {
                let payload = read_json_or_400!(request);
                let scale_factor = match handlers::parse_window_zoom_percent(&payload) {
                    Ok(scale_factor) => scale_factor,
                    Err(error) => return response::error_response(request, 400, &error),
                };
                match handlers::set_window_zoom(&state, scale_factor) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__store/save" => {
                let payload = read_json_or_400!(request);
                let query = response::parse_query(query);
                let result = state.store.bulk_save(payload);
                match result {
                    Ok(conflicts) => {
                        if query.get("snapshot").map(String::as_str) == Some("1") {
                            response::json_response(
                                request,
                                json!({
                                    "snapshot": state.store.snapshot_unacknowledged(),
                                    "conflicts": conflicts
                                }),
                            )
                        } else if conflicts > 0 {
                            // Concurrent-edit conflicts were resolved (kept one side);
                            // surface the count so clients can warn the user.
                            response::json_response(request, json!({ "conflicts": conflicts }))
                        } else {
                            response::no_content(request)
                        }
                    }
                    Err(error) => {
                        // Schema/validation failures are client errors: the
                        // frontend's saveWithRetry treats 4xx as "send a full
                        // snapshot" while 5xx would retry the broken payload.
                        let code = if error.contains("schemaVersion") {
                            400
                        } else {
                            500
                        };
                        response::error_response(request, code, &error)
                    }
                }
            }
            "/__store/ui_state" => {
                let payload = read_json_limited_or_error!(request, MAX_UI_STATE_REQUEST_BODY);
                match state.store.save_ui_state(&payload) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__store/ack_snapshot" => {
                let payload = read_json_or_400!(request);
                match state.store.acknowledge_frontend_snapshot(&payload) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__store/choose_data_dir" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                let Some(request) = confirm_or_400(request, &payload) else {
                    return Ok(());
                };
                match handlers::choose_data_dir(&state) {
                    Ok(Some(path)) => response::json_response(
                        request,
                        json!({ "path": path, "snapshot": state.store.snapshot_unacknowledged() }),
                    ),
                    Ok(None) => response::json_response(request, json!({ "path": null })),
                    Err(err) => response::error_response(request, 500, &err),
                }
            }
            "/__store/export_transfer" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                let Some(request) = confirm_or_400(request, &payload) else {
                    return Ok(());
                };
                match handlers::export_transfer(&state, &payload) {
                    Ok(result) => response::json_response(request, result),
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__store/import_transfer" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                let Some(request) = confirm_or_400(request, &payload) else {
                    return Ok(());
                };
                match handlers::import_transfer(&state, &payload) {
                    Ok(result) => response::json_response(request, result),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__store/upsert_text" => {
                let payload = read_json_or_400!(request);
                match state.store.upsert_text(&payload) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__store/delete_text" => {
                let payload = read_json_or_400!(request);
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match state.store.delete_text(id) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__store/wipe" => {
                let _ocr_guard = match state.ocr_slot.try_lock() {
                    Ok(guard) => guard,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        return response::error_response(
                            request,
                            409,
                            "Cannot wipe data while an OCR import is running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                match state.store.wipe() {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__book/image" => {
                let payload = read_json_limited_or_error!(request, MAX_IMAGE_REQUEST_BODY);
                if let Err(error) = validate_book_image_payload(&payload) {
                    return response::error_response(request, 400, &error);
                }
                match state.store.save_book_image(&payload) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__export/save" => {
                let payload = read_json_limited_or_error!(request, MAX_IMPORT_REQUEST_BODY);
                let Some(request) = confirm_or_400(request, &payload) else {
                    return Ok(());
                };
                match handlers::save_export(payload) {
                    Ok(saved) => response::json_response(request, json!({ "saved": saved })),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__import/ebook" => {
                let payload = read_json_limited_or_error!(request, MAX_IMPORT_REQUEST_BODY);
                match ebook::import(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__import/pdf_ocr/raw" => {
                let _ocr_guard = match state.ocr_slot.try_lock() {
                    Ok(guard) => guard,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        return response::error_response(
                            request,
                            409,
                            "Another OCR import is already running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                let params = response::parse_query(query);
                let job_id = params.get("job_id").cloned().unwrap_or_default();
                let _job_guard = match ActiveOcrJob::begin(&state.ocr_jobs, &job_id) {
                    Ok(guard) => guard,
                    Err(error) => return response::error_response(request, 400, &error),
                };
                let data = match response::read_body_limited(&mut request, MAX_RAW_PDF_BODY) {
                    Ok(data) => data,
                    Err(error) => return response::error_response(request, 413, &error),
                };
                let max_pages = params
                    .get("max_pages")
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0);
                let payload = json!({
                    "book_id": params.get("book_id").cloned().unwrap_or_default(),
                    "job_id": params.get("job_id").cloned().unwrap_or_default(),
                    "filename": params.get("filename").cloned().unwrap_or_default(),
                    "lang": params.get("lang").cloned().unwrap_or_else(|| "en".to_string()),
                    "max_pages": max_pages,
                });
                match pdf_ocr::import_bytes(
                    payload,
                    data,
                    &state.store,
                    &state.app_handle,
                    &state.ocr_jobs,
                ) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__import/image_ocr/raw" => {
                let _ocr_guard = match state.ocr_slot.try_lock() {
                    Ok(guard) => guard,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        return response::error_response(
                            request,
                            409,
                            "Another OCR import is already running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                let params = response::parse_query(query);
                let job_id = params.get("job_id").cloned().unwrap_or_default();
                let _job_guard = match ActiveOcrJob::begin(&state.ocr_jobs, &job_id) {
                    Ok(guard) => guard,
                    Err(error) => return response::error_response(request, 400, &error),
                };
                let content_type = request_header(&request, "Content-Type")
                    .unwrap_or("")
                    .to_string();
                let data = match response::read_body_limited(&mut request, MAX_RAW_OCR_IMAGE_BODY) {
                    Ok(data) => data,
                    Err(error) => return response::error_response(request, 413, &error),
                };
                let payload = json!({
                    "book_id": params.get("book_id").cloned().unwrap_or_default(),
                    "job_id": params.get("job_id").cloned().unwrap_or_default(),
                    "filename": params.get("filename").cloned().unwrap_or_default(),
                    "lang": params.get("lang").cloned().unwrap_or_else(|| "en".to_string()),
                    "content_type": content_type,
                });
                match pdf_ocr::import_image_bytes(
                    payload,
                    data,
                    &state.store,
                    &state.app_handle,
                    &state.ocr_jobs,
                ) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__import/ocr/cancel" | "/__import/pdf_ocr/cancel" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                match pdf_ocr::cancel(payload, &state.ocr_jobs) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__argos/install" => {
                let payload = read_json_or_400!(request);
                match offline_translator::install(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(_) => {
                        response::error_response(request, 500, "offline package install failed")
                    }
                }
            }
            "/__srs/review" => {
                let payload = read_json_or_400!(request);
                match srs::review(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__translate/external" => {
                let payload = read_json_or_400!(request);
                match external_translator::translate(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__ai/explain" => {
                let payload = read_json_or_400!(request);
                let prepared = match ai_explainer::prepare_request(&payload, false) {
                    Ok(prepared) => prepared,
                    Err(err) => return response::error_response(request, 400, &err),
                };
                let upstream = match ai_explainer::send_prepared_request(&prepared) {
                    Ok(upstream) => upstream,
                    Err(err) => return response::error_response(request, 502, &err),
                };
                match ai_explainer::parse_explanation_response(upstream) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 502, &err),
                }
            }
            "/__ai/explain_stream" => {
                let payload = read_json_or_400!(request);
                let prepared = match ai_explainer::prepare_request(&payload, true) {
                    Ok(prepared) => prepared,
                    Err(err) => return response::error_response(request, 400, &err),
                };
                // Connect upstream before consuming the tiny_http request. If
                // the provider is unreachable, the client still receives a
                // real HTTP error instead of ERR_EMPTY_RESPONSE.
                let upstream = match ai_explainer::send_prepared_request(&prepared) {
                    Ok(upstream) => upstream,
                    Err(err) => return response::error_response(request, 502, &err),
                };
                ai_explainer::relay_stream_response(upstream, request)
            }
            "/__text/vocab_index" => {
                let payload = read_json_or_400!(request);
                match vocab_index::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__youtube/captions" => {
                let payload = read_json_or_400!(request);
                match youtube_captions::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__vocab" => {
                let payload = read_json_or_400!(request);
                match vocab_export::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            _ => response::error_response(request, 404, "not found"),
        },
        _ => {
            // Known route prefix with an unsupported method — 405, not 404.
            if path.starts_with("/__") {
                response::error_response(request, 405, "method not allowed")
            } else {
                response::error_response(request, 404, "not found")
            }
        }
    }
}

#[cfg(test)]
mod confirm_gate_tests {
    use serde_json::json;

    use super::confirm_requested;

    #[test]
    fn confirm_requested_requires_an_explicit_boolean_true() {
        // Missing, false, null, and non-boolean values must never unlock a
        // native file dialog or a destructive store action (fix #110).
        assert!(!confirm_requested(&json!({})));
        assert!(!confirm_requested(&json!({ "confirm": false })));
        assert!(!confirm_requested(&json!({ "confirm": null })));
        assert!(!confirm_requested(&json!({ "confirm": "true" })));
        assert!(!confirm_requested(&json!({ "confirm": 1 })));
        assert!(confirm_requested(&json!({ "confirm": true })));
    }
}

#[cfg(test)]
#[path = "tests/http_boundary/tests.rs"]
mod tests;
