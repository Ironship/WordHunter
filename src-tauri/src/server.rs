use rand::{Rng, distributions::Alphanumeric};
use std::collections::{HashSet, VecDeque};
use std::net::TcpListener;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use tauri::AppHandle;
use tiny_http::{Request, Server};

use crate::store::Store;

const MAX_REGULAR_REQUEST_WORKERS: usize = 10;
const MAX_STORE_REQUEST_WORKERS: usize = 4;
const MAX_CONTROL_REQUEST_WORKERS: usize = 2;

/// Bounded FIFO queue shared by a fixed set of worker threads.
///
/// `try_push` rejects (returning the item) once `capacity` items are queued,
/// so the HTTP accept loop can answer 503 instead of spawning a thread per
/// request or queueing without bound. `pop` blocks until work is available.
struct BoundedWorkQueue<T> {
    queue: Mutex<VecDeque<T>>,
    not_empty: Condvar,
    capacity: usize,
}

impl<T> BoundedWorkQueue<T> {
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "worker pool capacity must be non-zero");
        Self {
            queue: Mutex::new(VecDeque::with_capacity(capacity)),
            not_empty: Condvar::new(),
            capacity,
        }
    }

    /// Enqueue a unit of work, or hand it back when the lane is at capacity.
    fn try_push(&self, item: T) -> Result<(), T> {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        if queue.len() >= self.capacity {
            return Err(item);
        }
        queue.push_back(item);
        self.not_empty.notify_one();
        Ok(())
    }

    /// Block until work is available, then take the oldest item.
    fn pop(&self) -> T {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(item) = queue.pop_front() {
                return item;
            }
            queue = self
                .not_empty
                .wait(queue)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

/// Spawn `count` fixed worker threads that drain `queue` and dispatch each
/// request to the router. This replaces the previous thread-per-request
/// model: no OS thread is created or destroyed per request, only once up
/// front (10 + 4 + 2 lanes = 16 workers total).
fn spawn_request_workers(
    queue: Arc<BoundedWorkQueue<Request>>,
    state: Arc<ServerState>,
    count: usize,
) {
    for _ in 0..count {
        let queue = Arc::clone(&queue);
        let state = Arc::clone(&state);
        thread::spawn(move || {
            loop {
                let request = queue.pop();
                // A fixed pool cannot self-heal a panicked worker the way the
                // old thread-per-request model did (a fresh thread was spawned
                // per request). Contain handler panics here so one bad request
                // never permanently removes a worker from its lane.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    crate::router::handle_request(request, Arc::clone(&state))
                }));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("request failed: {error}"),
                    Err(_) => eprintln!("request handler panicked"),
                }
            }
        });
    }
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

/// Bind a `TinyHTTP` server on a random port and spawn a fixed worker pool.
///
/// Requests are dispatched to `crate::router::handle_request` with the shared
/// state by 16 pre-spawned workers (10 regular + 4 store + 2 control lanes);
/// no thread is created per request. Lanes keep the queue capacity (10/4/2)
/// separate so long-running jobs cannot starve interactive control routes.
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

    // Fixed worker pools, one per request lane (10 + 4 + 2 = 16 workers).
    // Workers are spawned once here instead of thread-per-request, and each
    // lane keeps its own bounded queue so Control/Store capacity stays
    // available while Regular lanes (e.g. long TTS/OCR jobs) are saturated.
    let regular = Arc::new(BoundedWorkQueue::new(MAX_REGULAR_REQUEST_WORKERS));
    let store = Arc::new(BoundedWorkQueue::new(MAX_STORE_REQUEST_WORKERS));
    let control = Arc::new(BoundedWorkQueue::new(MAX_CONTROL_REQUEST_WORKERS));
    spawn_request_workers(
        Arc::clone(&regular),
        Arc::clone(&state),
        MAX_REGULAR_REQUEST_WORKERS,
    );
    spawn_request_workers(
        Arc::clone(&store),
        Arc::clone(&state),
        MAX_STORE_REQUEST_WORKERS,
    );
    spawn_request_workers(
        Arc::clone(&control),
        Arc::clone(&state),
        MAX_CONTROL_REQUEST_WORKERS,
    );

    // Accept loop: hand each request to its lane's pool, rejecting with 503
    // when the lane queue is full — the same backpressure as the old permits,
    // but without creating a thread per request.
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let pool = match request_lane(request.url()) {
                RequestLane::Regular => regular.as_ref(),
                RequestLane::Store => store.as_ref(),
                RequestLane::Control => control.as_ref(),
            };
            if let Err(request) = pool.try_push(request) {
                let _ = crate::response::error_response(request, 503, "server is busy; retry");
            }
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
    fn lane_queue_rejects_at_capacity_and_recovers_after_drain() {
        let queue = BoundedWorkQueue::new(2);
        assert!(queue.try_push(1).is_ok());
        assert!(queue.try_push(2).is_ok());
        assert_eq!(queue.try_push(3), Err(3));
        assert_eq!(queue.pop(), 1);
        assert!(queue.try_push(4).is_ok());
        assert_eq!(queue.pop(), 2);
        assert_eq!(queue.pop(), 4);
    }

    #[test]
    fn lane_queue_is_fifo_and_wakes_waiting_workers() {
        let queue = std::sync::Arc::new(BoundedWorkQueue::new(4));
        let queue_a = std::sync::Arc::clone(&queue);
        let queue_b = std::sync::Arc::clone(&queue);
        let a = std::thread::spawn(move || queue_a.pop());
        let b = std::thread::spawn(move || queue_b.pop());
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(queue.try_push(10).is_ok());
        assert!(queue.try_push(20).is_ok());
        let a = a.join().expect("worker a");
        let b = b.join().expect("worker b");
        let mut got = vec![a, b];
        got.sort_unstable();
        assert_eq!(got, vec![10, 20]);
    }
}
