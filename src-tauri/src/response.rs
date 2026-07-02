use serde_json::{Value, json};
use std::collections::HashMap;
use tiny_http::{Header, Request, Response, StatusCode};

/// Split a URL into path and query string components.
pub fn split_url(url: &str) -> (String, String) {
    let mut parts = url.splitn(2, '?');
    (
        parts.next().unwrap_or("/").to_string(),
        parts.next().unwrap_or("").to_string(),
    )
}

/// Parse a query string into a key-value map.
pub fn parse_query(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

/// Validate the X-WH-Token header against the expected server token.
pub fn valid_token(request: &Request, token: &str) -> bool {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("X-WH-Token"))
        .map(|header| header.value.as_str() == token)
        .unwrap_or(false)
}

/// Read the entire request body as raw bytes.
pub fn read_body(request: &mut Request) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    Ok(body)
}

/// Read the request body and parse it as JSON.
/// Returns an empty object `{}` when the body is empty.
pub fn read_json(request: &mut Request) -> Result<Value, String> {
    let body = read_body(request)?;
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

/// Respond with a JSON payload (HTTP 200).
pub fn json_response(request: Request, payload: Value) -> Result<(), String> {
    let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    respond(request, 200, body, "application/json; charset=utf-8", false)
}

/// Respond with HTTP 204 No Content and an empty body.
pub fn no_content(request: Request) -> Result<(), String> {
    respond(request, 204, Vec::new(), "text/plain", false)
}

/// Respond with a plain-text error message and the given HTTP status code.
pub fn error_response(request: Request, code: u16, message: &str) -> Result<(), String> {
    respond(
        request,
        code,
        message.as_bytes().to_vec(),
        "text/plain; charset=utf-8",
        false,
    )
}

/// Core response helper — send raw bytes with status code, content type,
/// CORS headers, and optional long-lived cache control.
pub fn respond(
    request: Request,
    code: u16,
    body: Vec<u8>,
    content_type: &str,
    cache: bool,
) -> Result<(), String> {
    let mut response = Response::from_data(body).with_status_code(StatusCode(code));
    response.add_header(
        Header::from_bytes("Content-Type", content_type)
            .map_err(|e| format!("bad Content-Type header: {e:?}"))?,
    );
    response.add_header(
        Header::from_bytes("Access-Control-Allow-Origin", "*")
            .map_err(|e| format!("bad Access-Control-Allow-Origin header: {e:?}"))?,
    );
    response.add_header(
        Header::from_bytes(
            "Cache-Control",
            if cache {
                "max-age=31536000"
            } else {
                "no-store"
            },
        )
        .map_err(|e| format!("bad Cache-Control header: {e:?}"))?,
    );
    request.respond(response).map_err(|e| e.to_string())
}
