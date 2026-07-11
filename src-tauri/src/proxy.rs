use std::io::{Read, Take};
use tiny_http::Request;
use url::Url;

use crate::response;

pub const USER_AGENT: &str = "WordHunter/1.0.2 (Tauri)";
const MAX_PROXY_BODY: u64 = 10_485_760;

/// Proxy endpoint — fetch remote resources for allowed domains only.
/// Currently permits gutenberg.org and gutendex.com.
pub fn serve_proxy(request: Request, query: &str) -> Result<(), String> {
    let params = response::parse_query(query);
    let Some(target) = params.get("url") else {
        return response::error_response(request, 400, "bad url");
    };
    let parsed = Url::parse(target).map_err(|e| e.to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if !matches!(host, "gutenberg.org" | "www.gutenberg.org" | "gutendex.com") {
        return response::error_response(request, 403, "domain not allowed");
    }
    let resp = crate::http::agent()
        .get(target)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| e.to_string())?;
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("text/plain; charset=utf-8")
        .to_string();
    let mut reader: Take<_> = resp.into_reader().take(MAX_PROXY_BODY);
    let mut body = Vec::new();
    reader.read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 >= MAX_PROXY_BODY {
        return response::error_response(request, 413, "response too large");
    }
    response::respond(request, 200, body, &content_type, false)
}
