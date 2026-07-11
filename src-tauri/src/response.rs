use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
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

/// Read at most `max_bytes` from a request body, rejecting oversized payloads
/// before JSON parsing duplicates their memory.
pub fn read_body_limited(request: &mut Request, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > max_bytes {
        return Err(format!("request body is too large (max {max_bytes} bytes)"));
    }
    Ok(body)
}

pub fn read_json_limited(request: &mut Request, max_bytes: usize) -> Result<Value, String> {
    let body = read_body_limited(request, max_bytes)?;
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
/// and optional long-lived cache control.
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
    for (name, value) in [
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
        ),
    ] {
        response.add_header(
            Header::from_bytes(name, value).map_err(|e| format!("bad {name} header: {e:?}"))?,
        );
    }
    request.respond(response).map_err(|e| e.to_string())
}
