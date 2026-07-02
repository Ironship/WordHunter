use rand::{Rng, distributions::Alphanumeric};
use std::collections::HashSet;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::Server;

use crate::store::Store;

pub struct ServerState {
    pub base_url: String,
    pub store: Arc<Store>,
    pub token: String,
    pub app_handle: AppHandle,
    pub ocr_cancellations: Mutex<HashSet<String>>,
}

/// Generate a random 32-character alphanumeric token for API authentication.
pub fn make_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Bind a `TinyHTTP` server on a random port and spawn a worker thread pool.
///
/// Each incoming request is dispatched to `crate::router::handle_request` with the shared state.
#[cfg(not(target_os = "android"))]
pub fn start_server(
    store: Arc<Store>,
    token: String,
    app_handle: AppHandle,
) -> Result<u16, String> {
    let listener = TcpListener::bind((crate::HOST, 0)).map_err(|e| e.to_string())?;
    start_server_from_listener(listener, store, token, app_handle)
}

#[cfg(target_os = "android")]
pub fn start_server_on_port(
    store: Arc<Store>,
    token: String,
    app_handle: AppHandle,
    port: u16,
) -> Result<u16, String> {
    let listener = TcpListener::bind((crate::HOST, port)).map_err(|e| e.to_string())?;
    start_server_from_listener(listener, store, token, app_handle)
}

fn start_server_from_listener(
    listener: TcpListener,
    store: Arc<Store>,
    token: String,
    app_handle: AppHandle,
) -> Result<u16, String> {
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = Server::from_listener(listener, None).map_err(|e| e.to_string())?;
    let state = Arc::new(ServerState {
        base_url: format!("http://{}:{}", crate::HOST, port),
        store,
        token,
        app_handle,
        ocr_cancellations: Mutex::new(HashSet::new()),
    });

    thread::spawn(move || {
        for request in server.incoming_requests() {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                if let Err(err) = crate::router::handle_request(request, state) {
                    eprintln!("request failed: {err}");
                }
            });
        }
    });

    Ok(port)
}
