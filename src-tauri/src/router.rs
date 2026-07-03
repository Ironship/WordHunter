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

/// Main request dispatcher.
pub fn handle_request(mut request: Request, state: Arc<ServerState>) -> Result<(), String> {
    let method = request.method().clone();
    let full_url = request.url().to_string();
    let (path, query) = response::split_url(&full_url);

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
        (Method::Get, "/__store/cloud_sync_status") => {
            response::json_response(request, handlers::cloud_sync_status(&state))
        }
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
        (Method::Get, path) if path.starts_with("/__book/text") => {
            let params = response::parse_query(&query);
            let id = params.get("id").cloned().unwrap_or_default();
            response::json_response(
                request,
                json!({ "text": state.store.get_text_content(&id)? }),
            )
        }
        (Method::Get, path) if path.starts_with("/__media") => {
            handlers::serve_media(request, &state, &query)
        }
        (Method::Get, path) if path.starts_with("/__proxy") => proxy::serve_proxy(request, &query),
        (Method::Get, path) if path.starts_with("/__open_dict") => {
            popup::serve_open_dict(request, &state.base_url, &state.app_handle, &query)
        }
        (Method::Get, "/__popup/close") => popup::serve_close_popup(request, &state.app_handle),
        (Method::Get, path) if path.starts_with("/__argos/status") => {
            response::json_response(request, offline_translator::status())
        }
        (Method::Get, "/__ocr/gpu-status") => {
            response::json_response(request, pdf_ocr::gpu_status(&state.app_handle))
        }
        (Method::Get, path) if path.starts_with("/__argos/packages") => {
            match offline_translator::packages() {
                Ok(payload) => response::json_response(request, payload),
                Err(err) => response::error_response(request, 500, &err),
            }
        }
        (Method::Get, path) if path.starts_with("/__argos/translate") => {
            match offline_translator::translate(&query) {
                Ok(payload) => response::json_response(request, payload),
                Err(err) => response::error_response(request, 500, &err),
            }
        }
        (Method::Get, path) if path.starts_with("/__argos/ui") => {
            handlers::serve_offline_translator_ui(request, &query)
        }
        (Method::Get, path) if path.starts_with("/__tts") => {
            handlers::serve_edge_tts(request, &query)
        }
        (Method::Get, _) => handlers::serve_static(request, &state, &path),
        (Method::Post, "/__log_error") => {
            let body = response::read_body(&mut request)?;
            // Cap log payload size to avoid stderr/disk-fill abuse from any page
            // loaded in the webview. The global error handler only sends short messages.
            const MAX_LOG_BODY: usize = 8 * 1024;
            let text = if body.len() > MAX_LOG_BODY {
                String::from_utf8_lossy(&body[..MAX_LOG_BODY]).into_owned() + "…[truncated]"
            } else {
                String::from_utf8_lossy(&body).into_owned()
            };
            eprintln!("{text}");
            response::no_content(request)
        }
        (Method::Post, _) => {
            if !response::valid_token(&request, &state.token) {
                return response::error_response(request, 403, "forbidden");
            }
            match path.as_str() {
                "/__store/save" => {
                    let payload = response::read_json(&mut request)?;
                    state.store.bulk_save(payload)?;
                    response::no_content(request)
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
                    Ok(Some((path, snapshot))) => response::json_response(
                        request,
                        json!({ "path": path, "snapshot": snapshot }),
                    ),
                    Ok(None) => response::json_response(request, json!({ "path": null })),
                    Err(err) => response::error_response(request, 500, &err),
                },
                "/__store/prepare_sync_dir" => match handlers::prepare_sync_dir(&state) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 500, &err),
                },
                "/__store/cloud_sync_connect_google" => {
                    match handlers::cloud_sync_connect_google(&state) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 500, &err),
                    }
                }
                "/__store/cloud_sync_now" => match handlers::cloud_sync_now(&state) {
                    Ok(payload) => response::json_response(request, payload),
                    Err(err) => response::error_response(request, 500, &err),
                },
                "/__store/sync_now" => match handlers::sync_now(&state) {
                    Ok(snapshot) => {
                        response::json_response(request, json!({ "snapshot": snapshot }))
                    }
                    Err(err) => response::error_response(request, 500, &err),
                },
                "/__store/sync_android_staging" => match handlers::sync_android_staging(&state) {
                    Ok(snapshot) => {
                        response::json_response(request, json!({ "snapshot": snapshot }))
                    }
                    Err(err) => response::error_response(request, 500, &err),
                },
                "/__store/resolve_conflict" => {
                    let payload = response::read_json(&mut request)?;
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
                    let payload = response::read_json(&mut request)?;
                    state.store.upsert_text(&payload)?;
                    response::no_content(request)
                }
                "/__store/delete_text" => {
                    let payload = response::read_json(&mut request)?;
                    let id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    state.store.delete_text(id)?;
                    response::no_content(request)
                }
                "/__store/wipe" => {
                    state.store.wipe()?;
                    response::no_content(request)
                }
                "/__book/image" => {
                    let payload = response::read_json(&mut request)?;
                    state.store.save_book_image(&payload)?;
                    response::no_content(request)
                }
                "/__export/save" => {
                    let payload = response::read_json(&mut request)?;
                    let saved = handlers::save_export(payload)?;
                    response::json_response(request, json!({ "saved": saved }))
                }
                "/__import/ebook" => {
                    let payload = response::read_json(&mut request)?;
                    response::json_response(request, ebook::import(payload)?)
                }
                "/__import/pdf_ocr" => {
                    let payload = response::read_json(&mut request)?;
                    response::json_response(
                        request,
                        pdf_ocr::import(
                            payload,
                            &state.store,
                            &state.app_handle,
                            &state.ocr_cancellations,
                        )?,
                    )
                }
                "/__import/pdf_ocr/cancel" => {
                    let payload = response::read_json(&mut request)?;
                    pdf_ocr::cancel(payload, &state.ocr_cancellations)?;
                    response::no_content(request)
                }
                "/__argos/install" => {
                    let payload = response::read_json(&mut request)?;
                    match offline_translator::install(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 500, &err),
                    }
                }
                "/__srs/review" => {
                    let payload = response::read_json(&mut request)?;
                    match srs::review(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__text/tokenize" => {
                    let payload = response::read_json(&mut request)?;
                    match tokenizer::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__translate/external" => {
                    let payload = response::read_json(&mut request)?;
                    match external_translator::translate(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__text/vocab_index" => {
                    let payload = response::read_json(&mut request)?;
                    match vocab_index::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__subtitles/parse" => {
                    let payload = response::read_json(&mut request)?;
                    match subtitles::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__youtube/captions" => {
                    let payload = response::read_json(&mut request)?;
                    match youtube_captions::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__youglish" => {
                    let payload = response::read_json(&mut request)?;
                    match youglish::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__update/parse" => {
                    let payload = response::read_json(&mut request)?;
                    match update::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__srs/ensure" => {
                    let payload = response::read_json(&mut request)?;
                    match srs::handle_ensure(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                "/__vocab" => {
                    let payload = response::read_json(&mut request)?;
                    match vocab_export::handle(payload) {
                        Ok(payload) => response::json_response(request, payload),
                        Err(err) => response::error_response(request, 400, &err),
                    }
                }
                _ => response::error_response(request, 404, "not found"),
            }
        }
        _ => response::error_response(request, 404, "not found"),
    }
}
