//! AI-powered context-aware explanations of words and phrases.
//!
//! The frontend posts the selected word or phrase together with the
//! surrounding sentence (and optionally a page image with the word's
//! bounding box for scanned books) to any OpenAI-compatible
//! `/chat/completions` endpoint: a local server (LM Studio, llama.cpp,
//! Ollama) or a remote provider (OpenAI, opencode.ai, DeepSeek, ...).
//! The key is passed in the request body and never stored by the app
//! beyond the user's own preference file.

use serde_json::{Value, json};
use std::sync::LazyLock;
use std::time::Duration;
use url::Url;

use crate::proxy::USER_AGENT;

const MAX_WORD_LEN: usize = 300;
const MAX_CONTEXT_LEN: usize = 8_000;
const MAX_IMAGE_DATA_URL_LEN: usize = 12 * 1024 * 1024;
// Generous budget: reasoning models (GLM, Qwen-Thinking, ...) spend tokens
// on `reasoning_content` before the actual explanation lands in `content`.
const MAX_EXPLANATION_TOKENS: u32 = 1500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(180);

static AI_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build()
});

/// OpenAI-compatible endpoints may be remote (https) or local (http on
/// loopback). Plain http to a remote host would leak the API key.
fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let parsed = Url::parse(endpoint).map_err(|_| "AI endpoint is not a valid URL".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(parsed.host_str().unwrap_or_default()) => Ok(()),
        "http" => Err(
            "AI endpoint over plain http is only allowed for local servers (localhost)".to_string(),
        ),
        _ => Err("AI endpoint must use http or https".to_string()),
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// Validate an optional data-URL image (`data:image/jpeg;base64,...`) that
/// vision-capable endpoints receive together with the word's bounding box.
fn validate_image(data_url: &str) -> Result<(), String> {
    let lower = data_url.to_ascii_lowercase();
    let supported = [
        "data:image/jpeg;base64,",
        "data:image/png;base64,",
        "data:image/webp;base64,",
    ];
    if !supported.iter().any(|prefix| lower.starts_with(prefix)) {
        return Err("AI image must be a JPEG, PNG or WebP data URL".to_string());
    }
    if data_url.len() > MAX_IMAGE_DATA_URL_LEN {
        return Err("AI image is too large".to_string());
    }
    Ok(())
}

fn build_user_content(
    word: &str,
    context: &str,
    from: &str,
    to: &str,
    image: Option<&str>,
    rect: Option<&Value>,
) -> Value {
    let mut prompt = format!(
        "Explain the word or phrase “{word}” as it is used in the context below.\n\
         Word or phrase: {word}\n\
         Context sentence: {context}\n\
         Word language: {from}\n\
         Explanation language: {to}\n\n\
         Explain what “{word}” means in this exact context, which part of speech \
         it is, any nuance or idiom it carries here, and give one short example \
         sentence of your own. Stay focused and learner-friendly."
    );
    if let Some(rect) = rect {
        if let (Some(x0), Some(y0), Some(x1), Some(y1)) = (
            rect.get("x0").and_then(Value::as_f64),
            rect.get("y0").and_then(Value::as_f64),
            rect.get("x1").and_then(Value::as_f64),
            rect.get("y1").and_then(Value::as_f64),
        ) {
            prompt.push_str(&format!(
                "\nThe word is highlighted in the attached page image between \
                 normalized coordinates ({x0:.3}, {y0:.3}) and ({x1:.3}, {y1:.3})."
            ));
        }
    }

    let Some(image) = image else {
        return json!(prompt);
    };
    json!([
        { "type": "text", "text": prompt },
        { "type": "image_url", "image_url": { "url": image } }
    ])
}

struct PreparedRequest {
    endpoint: String,
    api_key: String,
    body: Value,
}

fn prepare_request(payload: &Value, stream: bool) -> Result<PreparedRequest, String> {
    let word = payload
        .get("word")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let context = payload
        .get("context")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let from = payload.get("from").and_then(Value::as_str).unwrap_or("en");
    let to = payload.get("to").and_then(Value::as_str).unwrap_or("en");
    let endpoint = payload
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let api_key = payload
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let image = payload.get("image").and_then(Value::as_str).unwrap_or("");
    let rect = payload.get("rect");
    let effort = payload
        .get("effort")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();

    if word.is_empty() {
        return Err("word is missing".to_string());
    }
    if word.len() > MAX_WORD_LEN {
        return Err("word is too long".to_string());
    }
    if context.len() > MAX_CONTEXT_LEN {
        return Err("context is too long".to_string());
    }
    if model.is_empty() {
        return Err("AI model is missing".to_string());
    }
    validate_endpoint(endpoint)?;
    if !image.is_empty() {
        validate_image(image)?;
    }

    let system = format!(
        "You are an expert language-learning assistant. Explain the requested \
         word or phrase exactly as it is used in the given context, in simple \
         language a learner can understand. Always reply in {to}. Keep the \
         explanation under 120 words and never repeat the prompt instructions."
    );
    let user = build_user_content(
        word,
        context,
        from,
        to,
        (!image.is_empty()).then_some(image),
        rect,
    );

    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "max_tokens": MAX_EXPLANATION_TOKENS,
        "stream": stream
    });

    // Optional reasoning-effort level ("minimal" | "low" | "medium" | "high" |
    // "max"). Sent only when the user picked one — empty keeps the endpoint's
    // own default and stays compatible with endpoints that reject the field.
    // Defense in depth: only known levels are forwarded (the frontend already
    // normalizes, but a hand-crafted request must not smuggle arbitrary values).
    let mut body = body;
    if !effort.is_empty() {
        if effort.len() > 32 {
            return Err("AI effort is too long".to_string());
        }
        if !matches!(effort, "minimal" | "low" | "medium" | "high" | "max") {
            return Err("AI effort is invalid".to_string());
        }
        body["reasoning_effort"] = json!(effort);
    }

    Ok(PreparedRequest {
        endpoint: endpoint.to_string(),
        api_key: api_key.to_string(),
        body,
    })
}

fn send_request(prepared: &PreparedRequest) -> Result<ureq::Response, String> {
    let mut request = AI_AGENT
        .post(&prepared.endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", "application/json");
    let key = prepared.api_key.trim();
    if !key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {key}"));
    }

    request
        .send_json(prepared.body.clone())
        .map_err(|error| match error {
            ureq::Error::Status(code, response) => {
                let detail = response
                    .into_string()
                    .ok()
                    .map(|text| text.chars().take(300).collect::<String>())
                    .unwrap_or_default();
                if detail.is_empty() {
                    format!("AI endpoint returned HTTP {code}")
                } else {
                    format!("AI endpoint returned HTTP {code}: {detail}")
                }
            }
            ureq::Error::Transport(error) => format!("AI endpoint unreachable: {error}"),
        })
}

pub fn explain(payload: Value) -> Result<Value, String> {
    let prepared = prepare_request(&payload, false)?;
    let response = send_request(&prepared)?;
    let value: Value = response
        .into_json()
        .map_err(|error| format!("AI endpoint returned invalid JSON: {error}"))?;
    let explanation = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(|text| text.trim().trim_matches('"').to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "AI endpoint returned no explanation".to_string())?;

    Ok(json!({ "explanation": explanation, "engine": "ai" }))
}

/// Stream an OpenAI-compatible chat completion (SSE) through to the client.
/// The upstream response body is forwarded verbatim as `text/event-stream`,
/// so the webview receives deltas progressively and can render them live.
pub fn explain_stream(payload: Value, client: tiny_http::Request) -> Result<(), String> {
    let prepared = prepare_request(&payload, true)?;
    let response = send_request(&prepared)?;
    let status = response.status();
    if status != 200 {
        let detail = response
            .into_string()
            .ok()
            .map(|text| text.chars().take(300).collect::<String>())
            .unwrap_or_default();
        let message = if detail.is_empty() {
            format!("AI endpoint returned HTTP {status}")
        } else {
            format!("AI endpoint returned HTTP {status}: {detail}")
        };
        return crate::response::error_response(client, status, &message);
    }
    let reader = response.into_reader();
    crate::response::stream_response(client, "text/event-stream; charset=utf-8", reader)
}

#[cfg(test)]
mod tests {
    use super::{
        build_user_content, explain, explain_stream, is_loopback_host, prepare_request,
        validate_endpoint, validate_image,
    };
    use serde_json::json;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn endpoint_policy_allows_https_anywhere_and_loopback_http() {
        assert!(validate_endpoint("https://opencode.ai/zen/go/v1/chat/completions").is_ok());
        assert!(validate_endpoint("https://api.openai.com/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:1234/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://localhost:8080/v1/chat/completions").is_ok());
    }

    #[test]
    fn endpoint_policy_rejects_remote_plain_http_and_garbage() {
        assert!(validate_endpoint("http://example.com/v1/chat/completions").is_err());
        assert!(validate_endpoint("ftp://example.com/x").is_err());
        assert!(validate_endpoint("not a url").is_err());
        assert!(validate_endpoint("").is_err());
    }

    #[test]
    fn loopback_host_matches_common_aliases() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("192.168.0.25"));
        assert!(!is_loopback_host("example.com"));
    }

    #[test]
    fn image_must_be_a_supported_data_url() {
        assert!(validate_image("data:image/jpeg;base64,/9j/4AAQ").is_ok());
        assert!(validate_image("data:image/png;base64,iVBORw0KGgo").is_ok());
        assert!(validate_image("data:image/webp;base64,UklGR").is_ok());
        assert!(validate_image("data:image/gif;base64,R0lGOD").is_err());
        assert!(validate_image("https://example.com/page.jpg").is_err());
        assert!(validate_image("").is_err());
    }

    #[test]
    fn text_only_user_content_mentions_word_and_context() {
        let content = build_user_content("run", "She will run a marathon.", "en", "pl", None, None);
        let text = content.as_str().expect("plain text content without image");
        assert!(text.contains("run"));
        assert!(text.contains("She will run a marathon."));
        assert!(text.contains("Explanation language: pl"));
    }

    #[test]
    fn image_user_content_is_a_part_list_with_rect() {
        let content = build_user_content(
            "run",
            "She will run.",
            "en",
            "pl",
            Some("data:image/jpeg;base64,/9j/4AAQ"),
            Some(&json!({ "x0": 0.1, "y0": 0.2, "x1": 0.4, "y1": 0.3 })),
        );
        let parts = content.as_array().expect("image content is a part list");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["type"], "image_url");
        assert!(
            parts[0]["text"]
                .as_str()
                .unwrap()
                .contains("normalized coordinates (0.100, 0.200)")
        );
    }

    #[test]
    fn explain_validates_required_fields() {
        assert!(explain(json!({})).is_err());
        assert!(explain(json!({ "word": "run" })).is_err()); // no model
        assert!(explain(json!({ "word": "run", "model": "m" })).is_err()); // no endpoint
        assert!(
            explain(json!({
                "word": "run",
                "model": "m",
                "endpoint": "http://example.com/v1/chat/completions"
            }))
            .is_err()
        ); // remote plain http
    }

    /// Read a request's headers plus the Content-Length body so the mock
    /// server does not wait for the client to close the connection.
    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).expect("read request chunk");
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..n]);
            if let Some(pos) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buffer[..pos]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while buffer.len() < pos + 4 + content_length {
                    let n = stream.read(&mut chunk).expect("read request body");
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                }
                break;
            }
        }
        String::from_utf8_lossy(&buffer).to_string()
    }

    /// Serve a canned OpenAI-compatible response and check the module parses
    /// it, forwards the Authorization header and the reasoning effort.
    #[test]
    fn explain_parses_chat_completion_response_from_server() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_http_request(&mut stream);
            let body = r#"{
                "id": "chatcmpl-test",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "W tym zdaniu „run” to czasownik oznaczający biegnąć."
                    },
                    "finish_reason": "stop"
                }]
            }"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            assert!(request.contains("Authorization: Bearer test-key-123"));
            assert!(request.contains("\"model\":\"local-vision\""));
            assert!(
                request.contains("\"reasoning_effort\":\"high\""),
                "reasoning effort must be forwarded: {request}"
            );
        });

        let endpoint = format!("http://{address}/v1/chat/completions");
        let result = explain(json!({
            "word": "run",
            "context": "She will run a marathon.",
            "from": "en",
            "to": "pl",
            "endpoint": endpoint,
            "apiKey": "test-key-123",
            "model": "local-vision",
            "effort": "high"
        }));
        let value = result.expect("explain should succeed against the mock server");
        assert_eq!(value["engine"], "ai");
        assert!(value["explanation"].as_str().unwrap().contains("czasownik"));
        server.join().unwrap();
    }

    #[test]
    fn rejects_unknown_reasoning_effort_levels() {
        // The allowlist check must fail BEFORE any request is sent, so the
        // endpoint can be a dead address.
        let result = explain(json!({
            "word": "run",
            "context": "She will run.",
            "from": "en",
            "to": "pl",
            "endpoint": "http://127.0.0.1:9/v1/chat/completions",
            "apiKey": "test",
            "model": "local-vision",
            "effort": "bogus"
        }));
        assert!(result.is_err());
    }

    #[test]
    fn stream_request_sets_the_stream_flag() {
        let prepared = prepare_request(
            &json!({ "word": "run", "endpoint": "http://127.0.0.1:1234/v1/chat/completions", "model": "m" }),
            true,
        )
        .expect("stream request should prepare");
        assert_eq!(prepared.body["stream"], true);
        let plain = prepare_request(
            &json!({ "word": "run", "endpoint": "http://127.0.0.1:1234/v1/chat/completions", "model": "m" }),
            false,
        )
        .expect("plain request should prepare");
        assert_eq!(plain.body["stream"], false);
    }

    #[test]
    fn reasoning_effort_is_forwarded_only_when_picked() {
        let with_effort = prepare_request(
            &json!({
                "word": "run",
                "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
                "model": "m",
                "effort": "max"
            }),
            false,
        )
        .expect("request with effort should prepare");
        assert_eq!(with_effort.body["reasoning_effort"], "max");

        let without = prepare_request(
            &json!({
                "word": "run",
                "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
                "model": "m",
                "effort": "  "
            }),
            false,
        )
        .expect("request without effort should prepare");
        assert!(
            without.body.get("reasoning_effort").is_none(),
            "empty effort must not be sent"
        );

        let invalid = prepare_request(
            &json!({
                "word": "run",
                "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
                "model": "m",
                "effort": "x".repeat(40)
            }),
            false,
        );
        assert!(invalid.is_err(), "overlong effort must be rejected");
    }

    /// End-to-end: a tiny_http server runs the streaming handler, an upstream
    /// mock serves SSE chunks, and the client receives them progressively
    /// (chunked transfer, `text/event-stream` content type).
    #[test]
    fn explain_stream_forwards_sse_chunks_to_the_client() {
        use std::io::{Read, Write as IoWrite};
        use std::net::TcpStream;

        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream);
            assert!(
                request.contains("\"stream\":true"),
                "missing stream flag: {request}"
            );
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hej\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\" tam\"}}]}\n\n\
                        data: [DONE]\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let app = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let app_addr = app.server_addr().to_ip().unwrap();
        let app_thread = thread::spawn(move || {
            let request = app.recv().unwrap();
            let payload = json!({
                "word": "run",
                "endpoint": format!("http://{upstream_addr}/v1/chat/completions"),
                "model": "local-model"
            });
            explain_stream(payload, request).expect("stream should forward");
        });

        let mut client = TcpStream::connect((app_addr.ip(), app_addr.port())).unwrap();
        client
            .write_all(
                b"POST /__ai/explain_stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
            .unwrap();
        let mut output = String::new();
        client.read_to_string(&mut output).unwrap();

        assert!(
            output.contains("text/event-stream"),
            "bad content type: {output}"
        );
        assert!(output.contains("Hej"), "missing first chunk: {output}");
        assert!(output.contains(" tam"), "missing second chunk: {output}");
        assert!(output.contains("[DONE]"), "missing terminator: {output}");

        app_thread.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn explain_reports_http_error_with_body_snippet() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_http_request(&mut stream);
            let body = r#"{"error":{"message":"model not found"}}"#;
            let response = format!(
                "HTTP/1.1 404 Not Found
Content-Type: application/json
Content-Length: {}
Connection: close

{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let endpoint = format!("http://{address}/v1/chat/completions");
        let error = explain(json!({
            "word": "run",
            "endpoint": endpoint,
            "model": "missing-model"
        }))
        .expect_err("HTTP 404 should surface as an error");
        assert!(error.contains("HTTP 404"), "unexpected error: {error}");
        assert!(
            error.contains("model not found"),
            "unexpected error: {error}"
        );
        server.join().unwrap();
    }
}
