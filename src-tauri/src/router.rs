use include_dir::{Dir, include_dir};
use serde_json::{Value, json};
use std::sync::Arc;
use tiny_http::{Method, Request};

use crate::{
    ebook, external_translator, handlers, offline_translator, pdf_ocr, popup, proxy, response,
    server::ServerState, srs, subtitles, tokenizer, update, vocab_export, vocab_index, youglish,
    youtube_captions,
};

pub(crate) static WEB_ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src/web");

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
const MAX_RAW_PDF_BODY: usize = 256 * 1024 * 1024;
const MAX_IMAGE_REQUEST_BODY: usize = 32 * 1024 * 1024;
const MAX_COMMAND_REQUEST_BODY: usize = 8 * 1024;
const MAX_JSON_REQUEST_BODY: usize = 128 * 1024 * 1024;
const MAX_LOG_BODY: usize = 8 * 1024;

fn request_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
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
    request_header(request, "Origin").is_none_or(|origin| origin == base_url || origin == "null")
}

fn authenticate_request(
    request: Request,
    path: &str,
    token: &str,
) -> Result<Option<Request>, String> {
    if request.method() == &Method::Post
        && path != "/__log_error"
        && !response::valid_token(&request, token)
    {
        response::error_response(request, 403, "forbidden")?;
        return Ok(None);
    }
    Ok(Some(request))
}

fn dispatch_state_independent_request(
    mut request: Request,
    path: &str,
    query: &str,
) -> Result<Option<Request>, String> {
    match (request.method(), path) {
        (&Method::Get, "/__proxy") => {
            proxy::serve_proxy(request, query)?;
            Ok(None)
        }
        (&Method::Post, "/__text/tokenize") => {
            let payload = match response::read_json_limited(&mut request, MAX_JSON_REQUEST_BODY) {
                Ok(payload) => payload,
                Err(error) => {
                    let status = if error.contains("too large") {
                        413
                    } else {
                        400
                    };
                    response::error_response(
                        request,
                        status,
                        &format!("invalid JSON body: {error}"),
                    )?;
                    return Ok(None);
                }
            };
            match tokenizer::handle(payload) {
                Ok(payload) => response::json_response(request, payload)?,
                Err(error) => response::error_response(request, 400, &error)?,
            }
            Ok(None)
        }
        _ => Ok(Some(request)),
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
    let Some(request) = authenticate_request(request, &path, &state.token)? else {
        return Ok(());
    };
    let Some(mut request) = dispatch_state_independent_request(request, &path, &query)? else {
        return Ok(());
    };

    match (method, path.as_str()) {
        (Method::Get, "/") | (Method::Get, "/index.html") => handlers::serve_index(request, &state),
        (Method::Get, "/__store/load") => response::json_response(request, state.store.snapshot()),
        (Method::Get, "/__store/data_dir") => {
            response::json_response(request, json!({ "path": state.store.dir() }))
        }
        (Method::Get, "/__store/sync_status") => {
            response::json_response(request, state.store.sync_status())
        }
        (Method::Get, "/__store/sync_health") => {
            response::json_response(request, handlers::sync_health())
        }
        (Method::Get, "/__syncthing/status") => {
            response::json_response(request, handlers::syncthing_status(&state))
        }
        (Method::Get, "/__syncthing/qr") => match handlers::syncthing_device_qr(&state) {
            Ok(svg) => response::respond(request, 200, svg.into_bytes(), "image/svg+xml", false),
            Err(err) => response::error_response(request, 500, &err),
        },
        (Method::Get, "/__store/recovery_status") => {
            response::json_response(request, state.store.recovery_status())
        }
        (Method::Get, "/__data") => {
            crate::platform::open_path(state.store.dir());
            response::no_content(request)
        }
        (Method::Get, "/__update/check") => response::json_response(
            request,
            update::check(proxy::USER_AGENT, crate::APP_VERSION),
        ),
        (Method::Get, "/__book/text") => {
            let params = response::parse_query(&query);
            let id = params.get("id").cloned().unwrap_or_default();
            response::json_response(
                request,
                json!({ "text": state.store.get_text_content(&id)? }),
            )
        }
        (Method::Get, "/__media") => handlers::serve_media(request, &state, &query),
        (Method::Get, "/__open_dict") => {
            popup::serve_open_dict(request, &state.base_url, &state.app_handle, &query)
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
            Err(err) => response::error_response(request, 500, &err),
        },
        (Method::Get, "/__argos/translate") => match offline_translator::translate(&query) {
            Ok(payload) => response::json_response(request, payload),
            Err(err) => response::error_response(request, 500, &err),
        },
        (Method::Get, "/__argos/ui") => handlers::serve_offline_translator_ui(request, &query),
        (Method::Get, "/__tts") => handlers::serve_edge_tts(request, &query),
        (Method::Get, _) => handlers::serve_static(request, &path),
        (Method::Post, "/__log_error") => {
            let body = match response::read_body_limited(&mut request, MAX_LOG_BODY) {
                Ok(body) => body,
                Err(error) => return response::error_response(request, 413, &error),
            };
            let text = String::from_utf8_lossy(&body);
            eprintln!("{text}");
            response::no_content(request)
        }
        (Method::Post, _) => match path.as_str() {
            "/__store/save" => {
                let payload = read_json_or_400!(request);
                match state.store.bulk_save(payload) {
                    Ok(()) => {
                        if response::parse_query(&query)
                            .get("snapshot")
                            .map(String::as_str)
                            == Some("1")
                        {
                            response::json_response(
                                request,
                                json!({ "snapshot": state.store.snapshot() }),
                            )
                        } else {
                            response::no_content(request)
                        }
                    }
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__store/choose_data_dir" => match handlers::choose_data_dir(&state) {
                Ok(Some(path)) => response::json_response(
                    request,
                    json!({ "path": path, "snapshot": state.store.snapshot() }),
                ),
                Ok(None) => response::json_response(request, json!({ "path": null })),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__store/choose_sync_dir" => match handlers::choose_sync_dir(&state) {
                Ok(Some((path, snapshot))) => {
                    response::json_response(request, json!({ "path": path, "snapshot": snapshot }))
                }
                Ok(None) => response::json_response(request, json!({ "path": null })),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__store/prepare_sync_dir" => match handlers::prepare_sync_dir(&state) {
                Ok(payload) => response::json_response(request, payload),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__syncthing/start" => match handlers::syncthing_start(&state) {
                Ok(payload) => response::json_response(request, payload),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__syncthing/stop" => match handlers::syncthing_stop(&state) {
                Ok(payload) => response::json_response(request, payload),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__syncthing/pair" => {
                let payload = read_json_or_400!(request);
                let device_id = payload
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let device_name = payload
                    .get("deviceName")
                    .and_then(Value::as_str)
                    .unwrap_or(device_id);
                match handlers::syncthing_pair(&state, device_id, device_name) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 500, &err),
                }
            }
            "/__store/sync_now" => match handlers::sync_now(&state) {
                Ok(snapshot) => response::json_response(request, json!({ "snapshot": snapshot })),
                Err(err) => response::error_response(request, 500, &err),
            },
            "/__store/sync_android_staging" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                match handlers::sync_android_staging(&state, &payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 500, &err),
                }
            }
            "/__store/resolve_conflict" => {
                let payload = read_json_or_400!(request);
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let resolution = payload
                    .get("resolution")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match state.store.resolve_sync_conflict(id, resolution) {
                    Ok(snapshot) => {
                        response::json_response(request, json!({ "snapshot": snapshot }))
                    }
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__store/upsert_text" => {
                let payload = read_json_or_400!(request);
                state.store.upsert_text(&payload)?;
                response::no_content(request)
            }
            "/__store/delete_text" => {
                let payload = read_json_or_400!(request);
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                state.store.delete_text(id)?;
                response::no_content(request)
            }
            "/__store/wipe" => {
                let _ocr_guard = match state.ocr_slot.try_lock() {
                    Ok(guard) => guard,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        return response::error_response(
                            request,
                            409,
                            "Cannot wipe data while a PDF import is running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                state.store.wipe()?;
                response::no_content(request)
            }
            "/__book/image" => {
                let payload = read_json_limited_or_error!(request, MAX_IMAGE_REQUEST_BODY);
                match state.store.save_book_image(&payload) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 500, &error),
                }
            }
            "/__export/save" => {
                let payload = read_json_or_400!(request);
                let saved = handlers::save_export(payload)?;
                response::json_response(request, json!({ "saved": saved }))
            }
            "/__import/ebook" => {
                let payload = read_json_limited_or_error!(request, MAX_IMPORT_REQUEST_BODY);
                match ebook::import(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__import/pdf_ocr" => {
                let _ocr_guard = match state.ocr_slot.try_lock() {
                    Ok(guard) => guard,
                    Err(std::sync::TryLockError::WouldBlock) => {
                        return response::error_response(
                            request,
                            409,
                            "Another PDF import is already running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                let payload = read_json_limited_or_error!(request, MAX_IMPORT_REQUEST_BODY);
                match pdf_ocr::import(
                    payload,
                    &state.store,
                    &state.app_handle,
                    &state.ocr_cancellations,
                ) {
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
                            "Another PDF import is already running",
                        );
                    }
                    Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                };
                let data = match response::read_body_limited(&mut request, MAX_RAW_PDF_BODY) {
                    Ok(data) => data,
                    Err(error) => return response::error_response(request, 413, &error),
                };
                let params = response::parse_query(&query);
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
                    &state.ocr_cancellations,
                ) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(error) => response::error_response(request, 422, &error),
                }
            }
            "/__import/pdf_ocr/cancel" => {
                let payload = read_json_limited_or_error!(request, MAX_COMMAND_REQUEST_BODY);
                match pdf_ocr::cancel(payload, &state.ocr_cancellations) {
                    Ok(()) => response::no_content(request),
                    Err(error) => response::error_response(request, 400, &error),
                }
            }
            "/__argos/install" => {
                let payload = read_json_or_400!(request);
                match offline_translator::install(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 500, &err),
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
            "/__text/vocab_index" => {
                let payload = read_json_or_400!(request);
                match vocab_index::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__subtitles/parse" => {
                let payload = read_json_or_400!(request);
                match subtitles::handle(payload) {
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
            "/__youglish" => {
                let payload = read_json_or_400!(request);
                match youglish::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__update/parse" => {
                let payload = read_json_or_400!(request);
                match update::handle(payload) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 400, &err),
                }
            }
            "/__srs/ensure" => {
                let payload = read_json_or_400!(request);
                match srs::handle_ensure(payload) {
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
        _ => response::error_response(request, 404, "not found"),
    }
}

#[cfg(test)]
#[path = "tests/http_boundary/tests.rs"]
mod tests;
