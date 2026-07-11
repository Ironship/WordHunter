use serde_json::{Value, json};
#[cfg(not(target_os = "android"))]
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::process::Stdio;
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};

#[cfg(not(target_os = "android"))]
const API_KEY_SUFFIX: &str = "syncthing-apikey";
#[cfg(not(target_os = "android"))]
const PORT_SUFFIX: &str = "syncthing-port";
#[cfg(not(target_os = "android"))]
const DEFAULT_GUI_PORT: u16 = 58384;
#[cfg(not(target_os = "android"))]
const BINARY_NAME: &str = "syncthing";
#[cfg(not(target_os = "android"))]
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(target_os = "android"))]
const API_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct SyncthingManager {
    #[cfg(not(target_os = "android"))]
    run_lock: Mutex<()>,
}

impl SyncthingManager {
    pub(crate) fn new() -> Self {
        Self {
            #[cfg(not(target_os = "android"))]
            run_lock: Mutex::new(()),
        }
    }

    #[cfg(target_os = "android")]
    pub(crate) fn status(&self) -> Value {
        json!({
            "running": false,
            "deviceId": null,
            "peers": [],
            "folderOk": false,
            "port": null,
            "binary": null,
            "external": true,
        })
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn status(&self) -> Value {
        let api_key = load_api_key().ok().flatten();
        let port = load_port().unwrap_or(DEFAULT_GUI_PORT);
        let key = api_key.as_deref().unwrap_or("");
        let running = !key.is_empty() && is_syncthing_reachable(port, key).unwrap_or(false);

        if !running {
            return json!({
                "running": false,
                "deviceId": null,
                "peers": [],
                "folderOk": false,
                "port": port,
                "binary": find_binary().map(|p| p.to_string_lossy().to_string()),
            });
        }

        let device_id = fetch_my_id(port, key).ok().flatten();
        let peers = fetch_peers(port, key).unwrap_or_default();
        let folder_ok = check_folder_shared(port, key).unwrap_or(false);

        json!({
            "running": true,
            "deviceId": device_id,
            "peers": peers,
            "folderOk": folder_ok,
            "port": port,
            "binary": find_binary().map(|p| p.to_string_lossy().to_string()),
        })
    }

    #[cfg(target_os = "android")]
    pub(crate) fn start(&self) -> Result<Value, String> {
        Err(start_on_android_hint())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn start(&self) -> Result<Value, String> {
        let _guard = self
            .run_lock
            .try_lock()
            .map_err(|_| "syncthing start is already in progress".to_string())?;

        if self.status()["running"].as_bool().unwrap_or(false) {
            return Ok(self.status());
        }

        let binary = find_binary().ok_or_else(|| {
            "syncthing binary not found. Install it or set WORDHUNTER_SYNCTHING env var."
                .to_string()
        })?;
        let home_dir = syncthing_home_dir()?;

        let (api_key, port) = prepare_syncthing_config(&binary, &home_dir)?;

        let stderr_log = home_dir.join("syncthing-stderr.log");
        let stderr_file = std::fs::File::create(&stderr_log)
            .map_err(|e| format!("could not create stderr log: {e}"))?;

        let mut child = std::process::Command::new(&binary)
            .arg("--home")
            .arg(&home_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_file))
            .spawn()
            .map_err(|e| format!("could not start syncthing: {e}"))?;

        let started = Instant::now();
        let mut startup_errors = String::new();
        loop {
            if started.elapsed() > STARTUP_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::read_to_string(&stderr_log).map(|log| {
                    startup_errors = log;
                });
                return Err(format!(
                    "syncthing not ready within 30s. stderr: {}",
                    truncate_for_status(&startup_errors)
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = std::fs::read_to_string(&stderr_log).map(|log| {
                        startup_errors = log;
                    });
                    return Err(format!(
                        "syncthing exited (status: {status}). stderr: {}",
                        truncate_for_status(&startup_errors)
                    ));
                }
                Ok(None) => {}
                Err(e) => {
                    return Err(format!("syncthing wait error: {e}"));
                }
            }
            if is_syncthing_reachable(port, &api_key).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }

        std::thread::spawn(move || {
            let _ = child.wait();
        });

        let device_id = fetch_my_id(port, &api_key)
            .ok()
            .flatten()
            .unwrap_or_default();

        if let Ok(folder_path) = crate::sync_assistant::managed_sync_dir() {
            let _ = set_folder_via_api(port, &api_key, &folder_path);
        }

        eprintln!("[syncthing] started on port {port}, device ID: {device_id}");
        Ok(self.status())
    }

    #[cfg(target_os = "android")]
    pub(crate) fn stop(&self) -> Result<Value, String> {
        Err("Embedded Syncthing is not available on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn stop(&self) -> Result<Value, String> {
        let _guard = self
            .run_lock
            .try_lock()
            .map_err(|_| "syncthing stop is already in progress".to_string())?;

        if let Ok(Some(key)) = load_api_key() {
            let port = load_port().unwrap_or(DEFAULT_GUI_PORT);
            if is_syncthing_reachable(port, &key).unwrap_or(false) {
                let _ = api_post(port, &key, "/rest/system/shutdown", &json!({}));
            }
        }
        clear_api_key();
        clear_port();
        eprintln!("[syncthing] stopped");
        Ok(self.status())
    }

    #[cfg(target_os = "android")]
    pub(crate) fn device_qr_svg(&self) -> Result<String, String> {
        Err("Use Syncthing Fork app to view QR code on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn device_qr_svg(&self) -> Result<String, String> {
        let device_id = fetch_my_id_from_status()?;
        generate_qr_svg(&device_id)
    }

    #[cfg(target_os = "android")]
    pub(crate) fn pair_device(
        &self,
        _device_id: &str,
        _device_name: &str,
    ) -> Result<Value, String> {
        Err("Use Syncthing Fork app to pair devices on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn pair_device(&self, device_id: &str, device_name: &str) -> Result<Value, String> {
        let _guard = self
            .run_lock
            .try_lock()
            .map_err(|_| "syncthing operation is already in progress".to_string())?;

        let api_key = load_api_key()?.ok_or_else(|| "syncthing is not running".to_string())?;
        let port = load_port().unwrap_or(DEFAULT_GUI_PORT);

        let my_id = fetch_my_id(port, &api_key)?
            .ok_or_else(|| "could not read own device ID".to_string())?;

        let config = fetch_config(port, &api_key)?;
        let config = add_device_to_config(config, device_id, device_name);
        let config = add_folder_to_device_config(config, device_id, &my_id);
        put_config(port, &api_key, &config)?;
        request_reload(port, &api_key)?;

        eprintln!("[syncthing] paired device {device_name} ({device_id})");
        Ok(self.status())
    }
}

// --- Config dir ---

#[cfg(not(target_os = "android"))]
fn syncthing_home_dir() -> Result<PathBuf, String> {
    let cfg = crate::paths::config_dir()?;
    Ok(cfg.join("wordhunter-syncthing"))
}

// --- Binary discovery ---

#[cfg(not(target_os = "android"))]
fn find_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("WORDHUNTER_SYNCTHING") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    for candidate in bundled_candidates() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    which(BINARY_NAME)
}

#[cfg(not(target_os = "android"))]
fn bundled_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from("/app/bin/syncthing"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join(BINARY_NAME));
        if cfg!(target_os = "windows") {
            candidates.push(dir.join("syncthing.exe"));
        }
    }
    candidates
}

#[cfg(not(target_os = "android"))]
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// --- Port management ---

#[cfg(not(target_os = "android"))]
fn pick_free_port(preferred: u16) -> u16 {
    for port in preferred..=65535 {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(100),
        )
        .is_err()
        {
            return port;
        }
    }
    preferred
}

// --- API key persistence ---

#[cfg(not(target_os = "android"))]
fn load_api_key() -> Result<Option<String>, String> {
    crate::paths::read_app_config(crate::APP_NAME, API_KEY_SUFFIX)
}

#[cfg(not(target_os = "android"))]
fn save_api_key(key: &str) -> Result<(), String> {
    crate::paths::write_app_config(crate::APP_NAME, API_KEY_SUFFIX, key.as_bytes())
}

#[cfg(not(target_os = "android"))]
fn clear_api_key() {
    let key_path = match crate::paths::app_config_path(crate::APP_NAME, API_KEY_SUFFIX) {
        Ok(p) => p,
        Err(_) => return,
    };
    let _ = crate::store::durable::remove_file_if_exists(&key_path);
}

#[cfg(not(target_os = "android"))]
fn load_port() -> Option<u16> {
    match crate::paths::read_app_config(crate::APP_NAME, PORT_SUFFIX) {
        Ok(Some(v)) => v.trim().parse::<u16>().ok(),
        _ => None,
    }
}

#[cfg(not(target_os = "android"))]
fn save_port(port: u16) -> Result<(), String> {
    crate::paths::write_app_config(crate::APP_NAME, PORT_SUFFIX, port.to_string().as_bytes())
}

#[cfg(not(target_os = "android"))]
fn clear_port() {
    let port_path = match crate::paths::app_config_path(crate::APP_NAME, PORT_SUFFIX) {
        Ok(p) => p,
        Err(_) => return,
    };
    let _ = crate::store::durable::remove_file_if_exists(&port_path);
}

// --- Config preparation (no XML manipulation except exact address string) ---

#[cfg(not(target_os = "android"))]
fn prepare_syncthing_config(binary: &Path, home: &Path) -> Result<(String, u16), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let config_xml = home.join("config.xml");
    crate::store::durable::recover_replace(&config_xml)
        .map_err(|e| format!("recover config.xml: {e}"))?;

    if !config_xml.exists() {
        let status = std::process::Command::new(binary)
            .arg("generate")
            .arg("--home")
            .arg(home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("syncthing generate failed: {e}"))?;
        if !status.success() {
            return Err(format!("syncthing generate exited with {status}"));
        }
    }

    let raw = std::fs::read_to_string(&config_xml).map_err(|e| format!("read config.xml: {e}"))?;

    let api_key = extract_apikey(&raw)?;
    let existing_port = extract_port(&raw);
    let port = pick_free_port(if existing_port > 0 {
        existing_port
    } else {
        DEFAULT_GUI_PORT
    });

    save_api_key(&api_key)?;
    save_port(port)?;

    if existing_port != port {
        let existing_addr = format!("<address>127.0.0.1:{existing_port}</address>");
        let new_addr = format!("<address>127.0.0.1:{port}</address>");
        let modified = raw.replace(&existing_addr, &new_addr);
        crate::store::durable::write_file_atomic(&config_xml, modified.as_bytes(), true)
            .map_err(|e| format!("write config.xml: {e}"))?;
    }

    Ok((api_key, port))
}

#[cfg(not(target_os = "android"))]
fn extract_apikey(xml: &str) -> Result<String, String> {
    let start = xml
        .find("<apikey>")
        .ok_or_else(|| "apikey tag not found in config.xml".to_string())?
        + "<apikey>".len();
    let end = xml[start..]
        .find("</apikey>")
        .ok_or_else(|| "apikey closing tag not found".to_string())?;
    Ok(xml[start..start + end].to_string())
}

#[cfg(not(target_os = "android"))]
fn extract_port(xml: &str) -> u16 {
    if let Some(start) = xml.find("<address>127.0.0.1:") {
        let after = start + "<address>127.0.0.1:".len();
        let end = xml[after..].find("</address>").unwrap_or(0);
        if end > 0
            && let Ok(p) = xml[after..after + end].parse::<u16>()
        {
            return p;
        }
    }
    0
}

// --- REST API client ---

#[cfg(not(target_os = "android"))]
fn api_url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}")
}

#[cfg(not(target_os = "android"))]
fn api_get(port: u16, api_key: &str, path: &str) -> Result<String, String> {
    let url = api_url(port, path);
    let response = ureq::get(&url)
        .set("X-API-Key", api_key)
        .timeout(API_TIMEOUT)
        .call()
        .map_err(|e| format!("syncthing get {path}: {e}"))?;
    response
        .into_string()
        .map_err(|e| format!("syncthing read response: {e}"))
}

#[cfg(not(target_os = "android"))]
fn api_post(port: u16, api_key: &str, path: &str, body: &Value) -> Result<String, String> {
    let url = api_url(port, path);
    let body_bytes = serde_json::to_vec(body).map_err(|e| format!("serialize body: {e}"))?;
    let response = ureq::post(&url)
        .set("X-API-Key", api_key)
        .set("Content-Type", "application/json")
        .timeout(API_TIMEOUT)
        .send_bytes(&body_bytes)
        .map_err(|e| format!("syncthing post {path}: {e}"))?;
    response
        .into_string()
        .map_err(|e| format!("syncthing read response: {e}"))
}

#[cfg(not(target_os = "android"))]
fn api_put_json(port: u16, api_key: &str, path: &str, body: &Value) -> Result<String, String> {
    let url = api_url(port, path);
    let body_bytes = serde_json::to_vec(body).map_err(|e| format!("serialize body: {e}"))?;
    let response = ureq::put(&url)
        .set("X-API-Key", api_key)
        .set("Content-Type", "application/json")
        .timeout(API_TIMEOUT)
        .send_bytes(&body_bytes)
        .map_err(|e| format!("syncthing put {path}: {e}"))?;
    response
        .into_string()
        .map_err(|e| format!("syncthing read response: {e}"))
}

// --- API calls ---

#[cfg(not(target_os = "android"))]
fn is_syncthing_reachable(port: u16, api_key: &str) -> Result<bool, String> {
    match api_get(port, api_key, "/rest/system/version") {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(not(target_os = "android"))]
fn fetch_my_id(port: u16, api_key: &str) -> Result<Option<String>, String> {
    let raw = api_get(port, api_key, "/rest/system/status")?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(value
        .get("myID")
        .and_then(Value::as_str)
        .map(|s| s.to_string()))
}

#[cfg(not(target_os = "android"))]
fn fetch_my_id_from_status() -> Result<String, String> {
    let api_key = load_api_key()?.ok_or_else(|| "syncthing is not running".to_string())?;
    let port = load_port().unwrap_or(DEFAULT_GUI_PORT);
    fetch_my_id(port, &api_key)?
        .ok_or_else(|| "could not read device ID from syncthing".to_string())
}

#[cfg(not(target_os = "android"))]
fn fetch_peers(port: u16, api_key: &str) -> Result<Vec<Value>, String> {
    let raw = api_get(port, api_key, "/rest/system/connections")?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(value
        .get("connections")
        .and_then(Value::as_object)
        .map(|conns| {
            conns
                .iter()
                .map(|(id, info)| {
                    json!({
                        "deviceId": id,
                        "name": info.get("name").and_then(Value::as_str).unwrap_or(id),
                        "connected": info.get("connected").and_then(Value::as_bool).unwrap_or(false),
                        "address": info.get("address").and_then(Value::as_str).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(not(target_os = "android"))]
fn check_folder_shared(port: u16, api_key: &str) -> Result<bool, String> {
    let raw = api_get(port, api_key, "/rest/config/folders")?;
    let folders: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let empty = vec![];
    let arr = folders.as_array().unwrap_or(&empty);
    Ok(arr
        .iter()
        .any(|f| f.get("id").and_then(Value::as_str) == Some("wordhunter-sync")))
}

#[cfg(not(target_os = "android"))]
fn fetch_config(port: u16, api_key: &str) -> Result<Value, String> {
    let raw = api_get(port, api_key, "/rest/config")?;
    serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))
}

#[cfg(not(target_os = "android"))]
fn put_config(port: u16, api_key: &str, config: &Value) -> Result<(), String> {
    api_put_json(port, api_key, "/rest/config", config)?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn request_reload(port: u16, api_key: &str) -> Result<(), String> {
    api_post(port, api_key, "/rest/system/config", &json!({}))?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn set_folder_via_api(port: u16, api_key: &str, folder_path: &Path) -> Result<(), String> {
    let config = fetch_config(port, api_key)?;
    let my_id = fetch_my_id(port, api_key)?.ok_or_else(|| "no device ID".to_string())?;
    let config = upsert_folder(config, folder_path, &my_id);
    put_config(port, api_key, &config)?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn upsert_folder(mut config: Value, folder_path: &Path, my_id: &str) -> Value {
    let path_str = folder_path.to_string_lossy().to_string();
    let folders = config.get_mut("folders").and_then(Value::as_array_mut);

    let existing = folders.and_then(|f| {
        f.iter_mut()
            .find(|f| f.get("id").and_then(Value::as_str) == Some("wordhunter-sync"))
    });

    if let Some(folder) = existing {
        if let Some(obj) = folder.as_object_mut() {
            obj.insert("path".to_string(), Value::String(path_str));
            let devices = obj
                .entry("devices".to_string())
                .or_insert_with(|| json!([]));
            if let Some(arr) = devices.as_array_mut()
                && !arr
                    .iter()
                    .any(|d| d.get("deviceID").and_then(Value::as_str) == Some(my_id))
            {
                arr.push(json!({ "deviceID": my_id }));
            }
        }
    } else {
        if let Some(folders) = config.get_mut("folders").and_then(Value::as_array_mut) {
            folders.insert(
                0,
                json!({
                    "id": "wordhunter-sync",
                    "label": "WordHunter Sync",
                    "path": path_str,
                    "type": "sendreceive",
                    "rescanIntervalS": 60,
                    "fsWatcherEnabled": true,
                    "fsWatcherDelayS": 10,
                    "paused": false,
                    "autoNormalize": true,
                    "filesystemType": "basic",
                    "devices": [{ "deviceID": my_id }],
                    "markerName": ".stfolder",
                    "order": "random",
                    "ignoreDelete": false,
                }),
            );
        }
    }

    config
}

#[cfg(not(target_os = "android"))]
fn add_device_to_config(mut config: Value, device_id: &str, device_name: &str) -> Value {
    let devices = config.get_mut("devices").and_then(Value::as_array_mut);

    if let Some(devices) = devices {
        if devices
            .iter()
            .any(|d| d.get("deviceID").and_then(Value::as_str) == Some(device_id))
        {
            return config;
        }
        devices.push(json!({
            "deviceID": device_id,
            "name": device_name,
            "compression": "metadata",
            "introducer": false,
            "skipIntroductionRemovals": false,
            "introducedBy": "",
            "addresses": ["dynamic"],
            "paused": false,
            "autoAcceptFolders": false,
        }));
    }

    config
}

#[cfg(not(target_os = "android"))]
fn add_folder_to_device_config(mut config: Value, device_id: &str, _my_id: &str) -> Value {
    let folders = config.get_mut("folders").and_then(Value::as_array_mut);

    if let Some(folders) = folders {
        for folder in folders.iter_mut() {
            if folder.get("id").and_then(Value::as_str) == Some("wordhunter-sync") {
                let devices = folder.get_mut("devices").and_then(Value::as_array_mut);
                if let Some(devices) = devices
                    && !devices
                        .iter()
                        .any(|d| d.get("deviceID").and_then(Value::as_str) == Some(device_id))
                {
                    devices.push(json!({ "deviceID": device_id }));
                }
                break;
            }
        }
    }

    config
}

// --- QR code (SVG) ---

#[cfg(not(target_os = "android"))]
fn generate_qr_svg(device_id: &str) -> Result<String, String> {
    use qrcode::QrCode;
    use qrcode::render::svg;

    let code = QrCode::new(device_id.as_bytes()).map_err(|e| format!("qr encode: {e}"))?;
    let svg = code
        .render()
        .min_dimensions(300, 300)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Ok(svg)
}

#[cfg(not(target_os = "android"))]
fn truncate_for_status(value: &str) -> String {
    const MAX: usize = 600;
    let value = value.trim();
    if value.chars().count() <= MAX {
        value.to_string()
    } else {
        format!(
            "{}...[truncated]",
            value.chars().take(MAX).collect::<String>()
        )
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn parses_generated_config_credentials() {
        let xml = "<configuration><gui><address>127.0.0.1:58384</address><apikey>secret-key</apikey></gui></configuration>";
        assert_eq!(extract_apikey(xml).as_deref(), Ok("secret-key"));
        assert_eq!(extract_port(xml), 58384);
        assert!(extract_apikey("<configuration />").is_err());
        assert_eq!(extract_port("<address>0.0.0.0:8384</address>"), 0);
    }

    #[test]
    fn upserts_wordhunter_folder_without_losing_other_config() {
        let config = json!({
            "options": { "urAccepted": -1 },
            "folders": [{
                "id": "wordhunter-sync",
                "path": "old",
                "devices": [{ "deviceID": "LOCAL" }]
            }]
        });
        let updated = upsert_folder(config, Path::new("new-folder"), "REMOTE");
        let folder = &updated["folders"][0];
        assert_eq!(folder["path"], "new-folder");
        assert_eq!(folder["devices"].as_array().map(Vec::len), Some(2));
        assert_eq!(updated["options"]["urAccepted"], -1);

        let updated_again = upsert_folder(updated, Path::new("new-folder"), "REMOTE");
        assert_eq!(
            updated_again["folders"][0]["devices"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn adds_new_folder_and_pairs_device_idempotently() {
        let config = json!({ "folders": [], "devices": [] });
        let with_folder = upsert_folder(config, Path::new("sync"), "LOCAL");
        assert_eq!(with_folder["folders"][0]["id"], "wordhunter-sync");
        assert_eq!(with_folder["folders"][0]["devices"][0]["deviceID"], "LOCAL");

        let paired = add_device_to_config(with_folder, "REMOTE", "Phone");
        let paired = add_device_to_config(paired, "REMOTE", "Phone");
        assert_eq!(paired["devices"].as_array().map(Vec::len), Some(1));
        let shared = add_folder_to_device_config(paired, "REMOTE", "LOCAL");
        let shared = add_folder_to_device_config(shared, "REMOTE", "LOCAL");
        assert_eq!(
            shared["folders"][0]["devices"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn status_truncation_is_unicode_safe() {
        let input = "ą".repeat(601);
        let truncated = truncate_for_status(&input);
        assert_eq!(
            truncated.chars().take(600).collect::<String>(),
            "ą".repeat(600)
        );
        assert!(truncated.ends_with("...[truncated]"));
    }

    #[test]
    fn qr_contains_an_svg_for_the_device_id() {
        let svg = generate_qr_svg("AAAA-BBBB-CCCC").expect("QR should render");
        assert!(svg.starts_with("<?xml"));
        assert!(svg.contains("<svg"));
    }
}

// --- Android hint ---

#[cfg(target_os = "android")]
fn start_on_android_hint() -> String {
    "Syncthing is not embedded in Word Hunter Pocket. \
     Install Syncthing Fork from Play Store or F-Droid, \
     then use the Syncthing app to pair devices and share \
     the WordHunterSync folder."
        .to_string()
}
