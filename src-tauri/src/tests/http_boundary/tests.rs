use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use tiny_http::{Method, Request, Server};

use super::{
    authenticate_request, dispatch_state_independent_request, method_not_allowed,
    valid_request_source, validate_book_image_payload,
};
use crate::{handlers, response};

const TOKEN: &str = "test-token";

struct TestResponse {
    status: u16,
    body: String,
}

fn handle_boundary_request(request: Request, base_url: &str) -> Result<(), String> {
    let url = request.url().to_string();
    let (path, query) = response::split_url(&url);
    if !valid_request_source(&request, base_url) {
        return response::error_response(request, 403, "forbidden request source");
    }
    if method_not_allowed(request.method(), path) {
        return response::error_response(request, 405, "method not allowed");
    }
    let Some(request) = authenticate_request(request, path, TOKEN)? else {
        return Ok(());
    };
    let Some(request) = dispatch_state_independent_request(request, path, query)? else {
        return Ok(());
    };
    if request.method() == &Method::Get {
        handlers::serve_static(request, path)
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
    let body = br#"{"schemaVersion":2,"texts":[],"prefs":{},"hiddenBooks":[],"vocab":{}}"#;

    let missing = send_request("POST", "/__store/save", None, Some(body));
    assert_eq!(missing.status, 403);
    assert_eq!(missing.body, "forbidden");

    let incorrect = send_request("POST", "/__store/save", Some("wrong"), Some(body));
    assert_eq!(incorrect.status, 403);

    // The boundary harness does not implement /__store/save, so a
    // token-valid request passes authentication and falls through to
    // the unknown-POST 404 instead of being rejected as 403.
    let accepted = send_request("POST", "/__store/save", Some(TOKEN), Some(body));
    assert_eq!(accepted.status, 404);
}

#[test]
fn method_and_route_selection_are_exact() {
    let wrong_method = send_request("GET", "/__store/save", None, None);
    assert_eq!(wrong_method.status, 405);

    let wrong_proxy_method = send_request("POST", "/__proxy", None, Some(b"{}"));
    assert_eq!(wrong_proxy_method.status, 405);

    let route_suffix = send_request(
        "POST",
        "/__store/save/extra",
        Some(TOKEN),
        Some(br#"{"schemaVersion":2,"texts":[],"prefs":{},"hiddenBooks":[],"vocab":{}}"#),
    );
    assert_eq!(route_suffix.status, 404);

    let proxy_suffix = send_request(
        "GET",
        "/__proxy/extra?url=https%3A%2F%2Fwww.gutenberg.org.evil.test%2Fbook",
        None,
        None,
    );
    assert_eq!(proxy_suffix.status, 404);

    // Routes deleted by fix #114 must be gone from the HTTP surface.
    // /__subtitles/parse never reached this harness even on main, so the
    // assertion locks the removal in; /__text/tokenize WAS dispatched by
    // dispatch_state_independent_request on main (400 for an empty op) and
    // must now fall through to the unknown-POST 404.
    let removed_subtitles = send_request("POST", "/__subtitles/parse", Some(TOKEN), Some(b"{}"));
    assert_eq!(removed_subtitles.status, 404);

    let removed_tokenizer = send_request("POST", "/__text/tokenize", Some(TOKEN), Some(b"{}"));
    assert_eq!(removed_tokenizer.status, 404);
}

#[test]
fn ai_model_discovery_route_is_protected_and_method_exact() {
    let wrong_method = send_request("GET", "/__ai/models", None, None);
    assert_eq!(wrong_method.status, 405);

    let missing_token = send_request(
        "POST",
        "/__ai/models",
        None,
        Some(br#"{"endpoint":"https://example.com/v1/chat/completions"}"#),
    );
    assert_eq!(missing_token.status, 403);

    // A valid token passes the boundary harness and reaches its intentionally
    // unimplemented POST fallback. Request preparation is covered in
    // ai_explainer's model-endpoint tests.
    let accepted = send_request(
        "POST",
        "/__ai/models",
        Some(TOKEN),
        Some(br#"{"endpoint":"https://example.com/v1/chat/completions"}"#),
    );
    assert_eq!(accepted.status, 404);
}

#[test]
fn malformed_and_empty_json_bodies_return_http_400() {
    // /__text/tokenize (the only JSON-reading route the plain boundary
    // harness used to dispatch) is gone since #114, so the malformed-body
    // contract is exercised through the /__store/save boundary harness.
    let dir = tempfile::tempdir().unwrap();
    let malformed = send_store_request(
        crate::store::test_store(dir.path(), "boundary-test"),
        "POST",
        "/__store/save",
        Some(b"{"),
    );
    assert_eq!(malformed.status, 400);
    assert!(malformed.body.contains("invalid JSON body"));

    let dir = tempfile::tempdir().unwrap();
    let empty = send_store_request(
        crate::store::test_store(dir.path(), "boundary-test"),
        "POST",
        "/__store/save",
        None,
    );
    assert_eq!(empty.status, 400);
    assert!(empty.body.contains("invalid JSON body"));
}

#[test]
fn book_image_payload_validation_rejects_missing_and_invalid_fields() {
    assert!(validate_book_image_payload(&serde_json::json!({})).is_err());
    assert!(
        validate_book_image_payload(&serde_json::json!({
            "book_id": "book",
            "img_name": "../escape.png",
            "base64_data": "not base64!"
        }))
        .is_err()
    );
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
                "POST /__store/save HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://attacker.example\r\nSec-Fetch-Site: cross-site\r\nX-WH-Token: {TOKEN}\r\nContent-Length: 0\r\n\r\n"
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
fn rejects_null_origin_writes_but_allows_null_origin_reads() {
    let post = "POST /__store/save HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: null\r\nX-WH-Token: {TOKEN}\r\nContent-Length: 0\r\n\r\n";
    // /__media is token-free by design — it proves the origin allowance itself.
    let get =
        "GET /__media?book=x&img=y HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: null\r\n\r\n";
    // The null-origin POST must be rejected up front (403). A null-origin
    // GET stays allowed — it reaches the handlers (404 here, not 403).
    for (template, expected_status) in [(post, " 403 "), (get, " 404 ")] {
        let (port, server) = spawn_boundary_server();
        let raw = template
            .replace("{port}", &port.to_string())
            .replace("{TOKEN}", TOKEN);
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        let status_line = response.lines().next().unwrap_or_default();
        assert!(
            status_line.contains(expected_status),
            "unexpected response: {status_line}"
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
    assert!(response.contains("Content-Security-Policy: default-src 'self'"));
    assert!(response.contains("frame-ancestors 'none'"));
    // The Discover view (and other user-configurable integrations) fetch
    // external https APIs (gutendex, wikipedia, youglish, deepl, dictionary,
    // AI endpoints) and local LM Studio (http://127.0.0.1). connect-src must
    // allow them — a bare 'self' silently kills every external fetch with a
    // CSP violation ("Could not fetch results." in Discover).
    assert!(response.contains("connect-src 'self' https: http://127.0.0.1:* http://localhost:*"));
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
    let script = handlers::bootstrap_script("\";\n</script>\\\u{2028}\u{2029}", false);
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
    assert!(script.contains("window.WH_IMAGE_OCR_AVAILABLE = false"));
    assert!(script.contains("'/__proxy?url=' + encodeURIComponent(url)"));
}

#[test]
fn bootstrap_defers_snapshot_load_to_store_endpoint() {
    let script = handlers::bootstrap_script("token", false);

    assert!(script.contains("window.__bridgeStatePromise = origFetch('/__store/load'"));
    assert!(script.contains("storeLoadController.abort(); }, 120000)"));
    assert!(script.contains("Store load timed out after 120 seconds"));
    assert!(!script.contains("window.__bridgeState = null"));
}

// --- /__store/save conflict surfacing (fix #108) ---------------------------
//
// The response shaping below mirrors router.rs exactly as the fix defines it
// (conflicts > 0 -> 200 {"conflicts": n}; snapshot=1 -> 200 with "snapshot"
// and "conflicts"; otherwise 204). It is replicated here — instead of calling
// the router directly — so the same test file compiles and runs against the
// pre-fix base branch, where the conflict count was computed by the merge but
// never surfaced anywhere in the HTTP response. On the base branch the bridge
// below yields 0 conflicts, so every conflicts-aware assertion fails at
// runtime; on the fix branch it yields the real count and they pass.

/// Bridges the pre-fix `bulk_save -> Result<(), String>` signature. On the
/// fix the identity impl returns the real conflict count; on the base branch
/// the count is unobservable, so the save surfaces as conflict-free.
trait ConflictCount {
    fn conflict_count(self) -> Result<usize, String>;
}

#[allow(dead_code)] // the other impl is the active one on the base branch
impl ConflictCount for Result<usize, String> {
    fn conflict_count(self) -> Result<usize, String> {
        self
    }
}

#[allow(dead_code)] // the other impl is the active one on this branch
impl ConflictCount for Result<(), String> {
    fn conflict_count(self) -> Result<usize, String> {
        self.map(|()| 0)
    }
}

fn full_payload(word: &str, status: &str) -> String {
    serde_json::json!({
        "schemaVersion": 2,
        "texts": [],
        "prefs": { "learningLanguage": "de" },
        "hiddenBooks": [],
        "vocab": {
            "de": {
                "preferences": {},
                "userBooks": [],
                "hiddenBuiltInBooks": [],
                "archivedBookIds": [],
                "vocab": {
                    word: { "word": word, "translation": "word", "status": status }
                }
            }
        }
    })
    .to_string()
}

fn conflicting_delta_payload(word: &str, status: &str) -> String {
    serde_json::json!({
        "schemaVersion": 2,
        "delta": true,
        "fullKeys": ["profile:de", "vocab:de:wort", "pref:learningLanguage"],
        "records": {
            "vocab": {
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {
                        word: { "word": word, "translation": "word", "status": status }
                    }
                }
            }
        }
    })
    .to_string()
}

/// A store whose on-disk records diverge from its acknowledged base: another
/// device (a second store over the same directory) edits the same word after
/// the first save, exactly like the snapshot.rs unit test does.
fn store_with_concurrent_edit(dir: &tempfile::TempDir) -> crate::store::Store {
    let store = crate::store::test_store(dir.path(), "boundary-test");
    store
        .bulk_save(serde_json::from_str(&full_payload("Wort", "learning")).unwrap())
        .unwrap();
    crate::store::test_store(dir.path(), "other-device")
        .bulk_save(serde_json::from_str(&full_payload("Wort", "known")).unwrap())
        .unwrap();
    store.invalidate_records_cache();
    store
}

fn handle_store_save_boundary_request(
    request: Request,
    store: &crate::store::Store,
    base_url: &str,
) -> Result<(), String> {
    let url = request.url().to_string();
    let (path, query) = response::split_url(&url);
    if !valid_request_source(&request, base_url) {
        return response::error_response(request, 403, "forbidden request source");
    }
    if method_not_allowed(request.method(), path) {
        return response::error_response(request, 405, "method not allowed");
    }
    let Some(mut request) = authenticate_request(request, path, TOKEN)? else {
        return Ok(());
    };
    let payload: serde_json::Value = match serde_json::from_slice(
        &response::read_body_limited(&mut request, 4 * 1024 * 1024).map_err(|e| e.to_string())?,
    ) {
        Ok(payload) => payload,
        Err(error) => {
            return response::error_response(request, 400, &format!("invalid JSON body: {error}"));
        }
    };
    let conflicts = store.bulk_save(payload).conflict_count()?;
    let query = response::parse_query(query);
    if query.get("snapshot").map(String::as_str) == Some("1") {
        response::json_response(
            request,
            serde_json::json!({
                "snapshot": store.snapshot_unacknowledged(),
                "conflicts": conflicts
            }),
        )
    } else if conflicts > 0 {
        response::json_response(request, serde_json::json!({ "conflicts": conflicts }))
    } else {
        response::no_content(request)
    }
}

fn spawn_store_boundary_server(store: crate::store::Store) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = Server::from_listener(listener, None).unwrap();
    let base_url = format!("http://127.0.0.1:{port}");
    let handle = thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("test request was not received");
        handle_store_save_boundary_request(request, &store, &base_url).unwrap();
    });
    (port, handle)
}

fn send_store_request(
    store: crate::store::Store,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> TestResponse {
    let (port, server) = spawn_store_boundary_server(store);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    let mut request = agent.request(method, &format!("http://127.0.0.1:{port}{path}"));
    request = request.set("X-WH-Token", TOKEN);
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
fn store_save_with_conflicts_returns_200_and_the_conflict_count() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_concurrent_edit(&dir);

    let response = send_store_request(
        store,
        "POST",
        "/__store/save",
        Some(conflicting_delta_payload("Wort", "mastered").as_bytes()),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body, r#"{"conflicts":1}"#);
}

#[test]
fn store_save_with_snapshot_flag_includes_snapshot_and_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_concurrent_edit(&dir);

    let response = send_store_request(
        store,
        "POST",
        "/__store/save?snapshot=1",
        Some(conflicting_delta_payload("Wort", "mastered").as_bytes()),
    );

    assert_eq!(response.status, 200);
    let payload: serde_json::Value = serde_json::from_str(&response.body).unwrap();
    assert!(payload.get("snapshot").is_some(), "missing snapshot key");
    assert_eq!(payload["conflicts"], 1);
}

#[test]
fn store_save_without_conflicts_returns_204() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::test_store(dir.path(), "boundary-test");

    let response = send_store_request(
        store,
        "POST",
        "/__store/save",
        Some(full_payload("Wort", "learning").as_bytes()),
    );

    assert_eq!(response.status, 204);
    assert!(response.body.is_empty());
}

#[test]
fn listener_carries_no_socket_timeout() {
    // Regression (2026-08-13, Android): setting SO_RCVTIMEO on the LISTENING
    // socket made accept() fail after 60 s of idle traffic on Android; the
    // vendored tiny_http then ended incoming_requests() and the server thread
    // dropped the listener — the app lost its whole HTTP backend mid-session
    // ("No text source found" on every book open). The slow-loris deadline
    // must live in the vendored accept path (connection.rs), not on the
    // listener. Pin both sides of the contract at the source level.
    let server_source = include_str!("../../server.rs");
    assert!(
        !server_source.contains("set_read_timeout"),
        "server.rs must not set a read timeout on the listening socket"
    );
    assert!(
        server_source.contains("connection.rs sets a 60 s read/write deadline"),
        "slow-loris protection must be delegated to the vendored accept path"
    );
    let connection_source = include_str!("../../../vendor/tiny_http/src/connection.rs");
    assert!(
        connection_source.contains("set_read_timeout(Some(Duration::from_secs(60)))"),
        "the vendored accept path must keep the per-connection deadline"
    );
}
