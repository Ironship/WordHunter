use rand::{Rng, distributions::Alphanumeric};
use std::collections::HashSet;
use std::net::TcpListener;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::Server;

use crate::store::Store;
use crate::syncthing_manager::SyncthingManager;

const MAX_REQUEST_WORKERS: usize = 16;

struct RequestPermit {
    active: Arc<(Mutex<usize>, Condvar)>,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        let (lock, available) = &*self.active;
        let mut count = lock.lock().unwrap_or_else(|error| error.into_inner());
        *count = count.saturating_sub(1);
        available.notify_one();
    }
}

fn acquire_request_permit(active: &Arc<(Mutex<usize>, Condvar)>) -> RequestPermit {
    let (lock, available) = &**active;
    let mut count = lock.lock().unwrap_or_else(|error| error.into_inner());
    while *count >= MAX_REQUEST_WORKERS {
        count = available
            .wait(count)
            .unwrap_or_else(|error| error.into_inner());
    }
    *count += 1;
    RequestPermit {
        active: Arc::clone(active),
    }
}

pub struct ServerState {
    pub base_url: String,
    pub store: Arc<Store>,
    pub token: String,
    pub app_handle: AppHandle,
    pub syncthing: SyncthingManager,
    pub ocr_cancellations: Mutex<HashSet<String>>,
    pub ocr_slot: Mutex<()>,
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
        syncthing: SyncthingManager::new(),
        ocr_cancellations: Mutex::new(HashSet::new()),
        ocr_slot: Mutex::new(()),
    });

    thread::spawn(move || {
        let active = Arc::new((Mutex::new(0_usize), Condvar::new()));
        for request in server.incoming_requests() {
            let permit = acquire_request_permit(&active);
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let _permit = permit;
                if let Err(err) = crate::router::handle_request(request, state) {
                    eprintln!("request failed: {err}");
                }
            });
        }
    });

    Ok(port)
}
