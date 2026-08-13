use rand::{Rng, distributions::Alphanumeric};
use std::collections::HashSet;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::Server;

use crate::store::Store;

const MAX_REGULAR_REQUEST_WORKERS: usize = 10;
const MAX_STORE_REQUEST_WORKERS: usize = 4;
const MAX_CONTROL_REQUEST_WORKERS: usize = 2;

struct RequestPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::Relaxed);
    }
}

fn try_acquire_request_permit(active: &Arc<AtomicUsize>, limit: usize) -> Option<RequestPermit> {
    active
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
            (count < limit).then_some(count + 1)
        })
        .ok()
        .map(|_| RequestPermit {
            active: Arc::clone(active),
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestLane {
    Regular,
    Store,
    Control,
}

fn request_lane(url: &str) -> RequestLane {
    let path = url.split('?').next().unwrap_or(url);
    if matches!(
        path,
        "/__app/close" | "/__import/ocr/cancel" | "/__import/pdf_ocr/cancel" | "/__log_error"
    ) {
        RequestLane::Control
    } else if path.starts_with("/__store/") {
        RequestLane::Store
    } else {
        RequestLane::Regular
    }
}

pub struct ServerState {
    pub base_url: String,
    pub store: Arc<Store>,
    pub token: String,
    pub app_handle: AppHandle,
    pub(crate) ocr_jobs: Mutex<OcrJobState>,
    pub ocr_slot: Mutex<()>,
    #[cfg(not(target_os = "android"))]
    pub exports: Mutex<std::collections::HashMap<String, crate::handlers::ExportJob>>,
}

#[derive(Default)]
pub(crate) struct OcrJobState {
    active: HashSet<String>,
    cancelled: HashSet<String>,
}

impl OcrJobState {
    pub(crate) fn is_cancelled(&self, job_id: &str) -> bool {
        self.cancelled.contains(job_id)
    }

    pub(crate) fn request_cancel(&mut self, job_id: &str) -> bool {
        if !self.active.contains(job_id) {
            return false;
        }
        self.cancelled.insert(job_id.to_string());
        true
    }
}

pub(crate) struct ActiveOcrJob<'a> {
    jobs: &'a Mutex<OcrJobState>,
    job_id: String,
}

impl<'a> ActiveOcrJob<'a> {
    pub(crate) fn begin(jobs: &'a Mutex<OcrJobState>, job_id: &str) -> Result<Self, String> {
        if job_id.trim().is_empty() {
            return Err("job_id required".to_string());
        }
        let mut state = jobs
            .lock()
            .map_err(|_| "OCR job state is unavailable".to_string())?;
        if !state.active.insert(job_id.to_string()) {
            return Err("OCR job is already active".to_string());
        }
        state.cancelled.remove(job_id);
        Ok(Self {
            jobs,
            job_id: job_id.to_string(),
        })
    }
}

impl Drop for ActiveOcrJob<'_> {
    fn drop(&mut self) {
        let mut state = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        state.active.remove(&self.job_id);
        state.cancelled.remove(&self.job_id);
    }
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
    // Slow-loris protection lives in the vendored tiny_http accept path
    // (connection.rs sets a 60 s read/write deadline per accepted socket).
    // A timeout must NOT be set on the listening socket itself: on Android
    // the kernel honors SO_RCVTIMEO on listen sockets, so accept() fails
    // after 60 s of idle traffic, tiny_http's incoming_requests() ends, and
    // the whole server thread drops the listener — the app then loses its
    // HTTP backend mid-session (observed 2026-08-13: "No text source
    // found" on every book open after ~a minute of reading).
    let server = Server::from_listener(listener, None).map_err(|e| e.to_string())?;
    let state = Arc::new(ServerState {
        base_url: format!("http://{}:{}", crate::HOST, port),
        store,
        token,
        app_handle,
        ocr_jobs: Mutex::new(OcrJobState::default()),
        ocr_slot: Mutex::new(()),
        #[cfg(not(target_os = "android"))]
        exports: Mutex::new(std::collections::HashMap::new()),
    });

    thread::spawn(move || {
        let regular = Arc::new(AtomicUsize::new(0));
        let store_requests = Arc::new(AtomicUsize::new(0));
        let control = Arc::new(AtomicUsize::new(0));
        for request in server.incoming_requests() {
            let (active, limit) = match request_lane(request.url()) {
                RequestLane::Regular => (&regular, MAX_REGULAR_REQUEST_WORKERS),
                RequestLane::Store => (&store_requests, MAX_STORE_REQUEST_WORKERS),
                RequestLane::Control => (&control, MAX_CONTROL_REQUEST_WORKERS),
            };
            let Some(permit) = try_acquire_request_permit(active, limit) else {
                let _ = crate::response::error_response(request, 503, "server is busy; retry");
                continue;
            };
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

#[cfg(test)]
mod request_lane_tests {
    use super::*;

    #[test]
    fn keeps_control_and_store_capacity_separate_from_long_jobs() {
        assert_eq!(request_lane("/__tts?text=test"), RequestLane::Regular);
        assert_eq!(request_lane("/__store/save"), RequestLane::Store);
        assert_eq!(request_lane("/__store/load?ack=0"), RequestLane::Store);
        assert_eq!(request_lane("/__app/close"), RequestLane::Control);
        assert_eq!(request_lane("/__import/ocr/cancel"), RequestLane::Control);
        assert_eq!(
            request_lane("/__import/pdf_ocr/cancel"),
            RequestLane::Control
        );
        assert_eq!(request_lane("/__log_error"), RequestLane::Control);
    }

    #[test]
    fn permit_rejects_at_capacity_and_recovers_after_release() {
        let active = Arc::new(AtomicUsize::new(0));
        let permit = try_acquire_request_permit(&active, 1).expect("first permit");
        assert!(try_acquire_request_permit(&active, 1).is_none());
        drop(permit);
        assert!(try_acquire_request_permit(&active, 1).is_some());
    }
}
