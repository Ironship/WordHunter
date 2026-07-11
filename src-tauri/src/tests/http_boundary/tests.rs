use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use tiny_http::{Method, Request, Server};

use super::{authenticate_request, dispatch_state_independent_request, valid_request_source};
use crate::{handlers, response};

const TOKEN: &str = "test-token";

struct TestResponse {
    status: u16,
    body: String,
}

fn handle_boundary_request(request: Request, base_url: &str) -> Result<(), String> {
    let (path, query) = response::split_url(request.url());
    if !valid_request_source(&request, base_url) {
        return response::error_response(request, 403, "forbidden request source");
    }
    let Some(request) = authenticate_request(request, &path, TOKEN)? else {
        return Ok(());
    };
    let Some(request) = dispatch_state_independent_request(request, &path, &query)? else {
        return Ok(());
    };
    if request.method() == &Method::Get {
        handlers::serve_static(request, &path)
    } else {
        response::error_response(request, 404, "not found")
    }
}

fn spawn_boundary_server() -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = Server::from_listener(listener, None).unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let handle = thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("test request was not received");
        handle_boundary_request(request, &base_url).unwrap();
    });
    (port, handle)
}

fn send_request(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&[u8]>,
) -> TestResponse {
    let (port, server) = spawn_boundary_server();
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    let mut request = agent.request(method, &format!("http://127.0.0.1:{port}{path}"));
    if let Some(token) = token {
        request = request.set("X-WH-Token", token);
    }
    let result = match body {
        Some(body) => request.send_bytes(body),
        None => request.call(),
    };
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => panic!("request failed without an HTTP response: {error}"),
    };
    let status = response.status();
    let body = response.into_string().unwrap();
    server.join().unwrap();
    TestResponse { status, body }
}

#[test]
fn protected_post_requires_the_exact_token() {
    let body = br#"{"op":"tokenize","text":"Hello!","algorithm":"classic"}"#;

    let missing = send_request("POST", "/__text/tokenize", None, Some(body));
    assert_eq!(missing.status, 403);
    assert_eq!(missing.body, "forbidden");

    let incorrect = send_request("POST", "/__text/tokenize", Some("wrong"), Some(body));
    assert_eq!(incorrect.status, 403);

    let accepted = send_request("POST", "/__text/tokenize", Some(TOKEN), Some(body));
    assert_eq!(accepted.status, 200);
    let payload: serde_json::Value = serde_json::from_str(&accepted.body).unwrap();
    assert_eq!(payload["tokens"][0]["value"], "Hello");
}

#[test]
fn method_and_route_selection_are_exact() {
    let wrong_method = send_request("GET", "/__text/tokenize", None, None);
    assert_eq!(wrong_method.status, 404);

    let route_suffix = send_request(
        "POST",
        "/__text/tokenize/extra",
        Some(TOKEN),
        Some(br#"{"op":"tokenize","text":"Hello"}"#),
    );
    assert_eq!(route_suffix.status, 404);

    let proxy_suffix = send_request(
        "GET",
        "/__proxy/extra?url=https%3A%2F%2Fwww.gutenberg.org.evil.test%2Fbook",
        None,
        None,
    );
    assert_eq!(proxy_suffix.status, 404);
}

#[test]
fn malformed_and_empty_json_bodies_return_http_400() {
    let malformed = send_request("POST", "/__text/tokenize", Some(TOKEN), Some(b"{"));
    assert_eq!(malformed.status, 400);
    assert!(malformed.body.contains("invalid JSON body"));

    let empty = send_request("POST", "/__text/tokenize", Some(TOKEN), None);
    assert_eq!(empty.status, 400);
    assert_eq!(empty.body, "missing op");
}

#[test]
fn static_path_traversal_returns_http_400() {
    let (port, server) = spawn_boundary_server();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(
            format!("GET /../index.html HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
        )
        .unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    server.join().unwrap();

    let status_line = response.lines().next().unwrap_or_default();
    assert!(
        status_line.contains(" 400 "),
        "unexpected response: {status_line}"
    );
    assert!(response.ends_with("invalid path"));
}

#[test]
fn rejects_dns_rebinding_hosts_and_cross_site_origins() {
    for request in [
        "GET /index.html HTTP/1.0\r\nHost: attacker.example\r\n\r\n".to_string(),
        String::new(),
    ] {
        let (port, server) = spawn_boundary_server();
        let raw = if request.is_empty() {
            format!(
                "POST /__text/tokenize HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://attacker.example\r\nSec-Fetch-Site: cross-site\r\nX-WH-Token: {TOKEN}\r\nContent-Length: 0\r\n\r\n"
            )
        } else {
            request
        };
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        assert!(
            response
                .lines()
                .next()
                .unwrap_or_default()
                .contains(" 403 ")
        );
    }
}

#[test]
fn static_responses_include_security_headers() {
    let (port, server) = spawn_boundary_server();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(format!("GET /index.html HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes())
        .unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    server.join().unwrap();

    assert!(response.contains("X-Content-Type-Options: nosniff"));
    assert!(response.contains("X-Frame-Options: DENY"));
    assert!(response.contains(
        "Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
    ));
}

#[test]
fn proxy_rejects_lookalike_host_without_network_access() {
    let response = send_request(
        "GET",
        "/__proxy?url=https%3A%2F%2Fwww.gutenberg.org.evil.test%2Fbook",
        None,
        None,
    );

    assert_eq!(response.status, 403);
    assert_eq!(response.body, "domain not allowed");
}

#[test]
fn bootstrap_escapes_javascript_and_proxy_url_values() {
    let snapshot = serde_json::json!({ "prefs": { "theme": "</script>\u{2028}" } });
    let script = handlers::bootstrap_script("\";\n</script>\\\u{2028}\u{2029}", Some(&snapshot));
    let token_line = script
        .lines()
        .find(|line| line.contains("window.WH_TOKEN"))
        .unwrap()
        .trim();

    assert_eq!(
        token_line,
        r#"window.WH_TOKEN = "\";\n<\/script>\\\u2028\u2029";"#
    );
    assert!(!script.contains("</script>"));
    assert!(script.contains(r#""theme":"<\/script>\u2028""#));
    assert!(script.contains("'/__proxy?url=' + encodeURIComponent(url)"));
}
