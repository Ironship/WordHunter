use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::store::Store;

const CONFIG_SUFFIX: &str = "cloud-sync";
const RCLONE_CONFIG_SUFFIX: &str = "rclone";
const STATUS_SUFFIX: &str = "cloud-sync-status";
const CONFIG_SCHEMA_VERSION: u64 = 1;
const STATUS_SCHEMA_VERSION: u64 = 1;
const DEFAULT_REMOTE_NAME: &str = "wordhunter-drive";
const DEFAULT_REMOTE_PATH: &str = "WordHunterSync";
const MARKER_DIR: &str = ".wordhunter-sync";
const MARKER_FILE: &str = "manifest.json";
const AUTH_PENDING_MESSAGE: &str = "Google Drive authorization is open in the browser. Approve it there, then return to WordHunter.";
const RCLONE_COMMAND_TIMEOUT: Duration = Duration::from_secs(180);
const RCLONE_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CloudSyncConfig {
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    provider: String,
    remote: String,
    #[serde(rename = "remotePath")]
    remote_path: String,
    #[serde(rename = "connectedAt")]
    connected_at: String,
}

pub(crate) struct CloudSync {
    run_lock: Mutex<()>,
}

impl CloudSync {
    pub(crate) fn new() -> Self {
        Self {
            run_lock: Mutex::new(()),
        }
    }

    #[cfg(target_os = "android")]
    pub(crate) fn status(&self) -> Value {
        json!({
            "schemaVersion": STATUS_SCHEMA_VERSION,
            "configured": false,
            "supported": false,
            "status": "not_supported",
            "message": "Google Drive cloud sync is not available on Android yet.",
        })
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn status(&self) -> Value {
        let config = load_config().ok().flatten();
        let mut status = load_status().unwrap_or_else(|| {
            json!({
                "schemaVersion": STATUS_SCHEMA_VERSION,
                "status": if config.is_some() { "ready" } else { "not_configured" },
            })
        });
        let auth_required = status.get("status").and_then(Value::as_str) == Some("auth_required");
        let configured = config.is_some() && !auth_required;
        status["configured"] = Value::Bool(configured);
        if auth_required {
            if let Some(object) = status.as_object_mut() {
                object.remove("provider");
                object.remove("remote");
                object.remove("remotePath");
            }
        }
        if configured {
            let config = config.expect("configured implies cloud sync config exists");
            status["provider"] = Value::String(config.provider.clone());
            status["remote"] = Value::String(remote_spec(&config));
            status["remotePath"] = Value::String(config.remote_path);
        }
        status
    }

    #[cfg(target_os = "android")]
    pub(crate) fn connect_google_drive(&self) -> Result<Value, String> {
        Err("Google Drive cloud sync is not available on Android yet".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn connect_google_drive(&self) -> Result<Value, String> {
        let _guard = self
            .run_lock
            .try_lock()
            .map_err(|_| "cloud sync is already running".to_string())?;
        let connector = DesktopRcloneConnector::discover()?;
        let _ = clear_config();
        write_status(status_value(
            "auth_required",
            None,
            Some(AUTH_PENDING_MESSAGE),
            Some("auth"),
        ))?;
        let remote = match connector.ensure_verified_google_drive_remote(DEFAULT_REMOTE_PATH) {
            Ok(remote) => remote,
            Err(error) => {
                let status = if is_authorization_error(&error) {
                    "auth_required"
                } else {
                    "error"
                };
                let message = authorization_failure_message(&error);
                let _ = write_status(status_value(status, None, Some(&message), Some("auth")));
                return Err(message);
            }
        };
        let config = CloudSyncConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            provider: "rclone".to_string(),
            remote,
            remote_path: DEFAULT_REMOTE_PATH.to_string(),
            connected_at: now_label(),
        };
        save_config(&config)?;
        write_status(status_value(
            "ready",
            Some(&config),
            Some("Google Drive connector is ready."),
            None,
        ))?;
        Ok(self.status())
    }

    #[cfg(target_os = "android")]
    pub(crate) fn sync_now(&self, _store: &Store) -> Result<Value, String> {
        Err("Google Drive cloud sync is not available on Android yet".to_string())
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn sync_now(&self, store: &Store) -> Result<Value, String> {
        let _guard = self
            .run_lock
            .try_lock()
            .map_err(|_| "cloud sync is already running".to_string())?;
        let config = load_config()?.ok_or_else(|| "cloud sync is not configured".to_string())?;
        let connector = DesktopRcloneConnector::discover()?;
        run_sync(store, &connector, &config).inspect_err(|error| {
            let status = if is_authorization_error(error) {
                "auth_required"
            } else {
                "error"
            };
            let message = if status == "auth_required" {
                let _ = clear_config();
                authorization_failure_message(error)
            } else {
                error.to_string()
            };
            let _ = write_status(status_value(status, Some(&config), Some(&message), None));
        })
    }
}

trait CloudConnector {
    fn ensure_remote_folder(&self, config: &CloudSyncConfig) -> Result<(), String>;
    fn pull(&self, config: &CloudSyncConfig, staging: &Path) -> Result<(), String>;
    fn push(&self, config: &CloudSyncConfig, local_sync_dir: &Path) -> Result<(), String>;
}

#[derive(Clone, Debug)]
struct DesktopRcloneConnector {
    binary: PathBuf,
    config: PathBuf,
}

impl DesktopRcloneConnector {
    fn discover() -> Result<Self, String> {
        let config = rclone_config_path()?;
        if let Some(path) = std::env::var_os("WORDHUNTER_RCLONE") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(Self {
                    binary: path,
                    config,
                });
            }
        }
        for candidate in bundled_rclone_candidates() {
            if candidate.is_file() {
                return Ok(Self {
                    binary: candidate,
                    config,
                });
            }
        }
        Ok(Self {
            binary: PathBuf::from(if cfg!(target_os = "windows") {
                "rclone.exe"
            } else {
                "rclone"
            }),
            config,
        })
    }

    fn ensure_google_drive_remote(&self) -> Result<String, String> {
        if let Some(remote) = self.pick_google_drive_remote()? {
            return Ok(remote);
        }
        self.create_default_google_drive_remote()
    }

    fn ensure_verified_google_drive_remote(&self, remote_path: &str) -> Result<String, String> {
        let remote = self.ensure_google_drive_remote()?;
        match self.ensure_remote_folder_named(&remote, remote_path) {
            Ok(()) => return Ok(remote),
            Err(first_error) if should_retry_authorization(&first_error) => {
                if remote == DEFAULT_REMOTE_NAME {
                    let _ = self.delete_remote(DEFAULT_REMOTE_NAME);
                }
                let retry_remote = self
                    .create_default_google_drive_remote()
                    .map_err(|retry_error| format!("{first_error}; retry failed: {retry_error}"))?;
                self.ensure_remote_folder_named(&retry_remote, remote_path)
                    .map_err(|retry_error| format!("{first_error}; retry failed: {retry_error}"))?;
                Ok(retry_remote)
            }
            Err(error) => Err(error),
        }
    }

    fn create_default_google_drive_remote(&self) -> Result<String, String> {
        if let Err(error) = self.create_google_drive_remote() {
            let _ = self.delete_remote(DEFAULT_REMOTE_NAME);
            return Err(error);
        }
        if self.remote_exists(DEFAULT_REMOTE_NAME)? {
            return Ok(DEFAULT_REMOTE_NAME.to_string());
        }
        Err(
            "Google Drive authorization completed, but the WordHunter remote was not created"
                .to_string(),
        )
    }

    fn pick_google_drive_remote(&self) -> Result<Option<String>, String> {
        let remotes = self.list_remote_names()?;
        for preferred in [DEFAULT_REMOTE_NAME, "gdrive"] {
            if remotes.iter().any(|remote| remote == preferred) {
                return Ok(Some(preferred.to_string()));
            }
        }
        Ok(None)
    }

    fn remote_exists(&self, name: &str) -> Result<bool, String> {
        Ok(self
            .list_remote_names()?
            .iter()
            .any(|remote| remote == name))
    }

    fn list_remote_names(&self) -> Result<Vec<String>, String> {
        let output = self.run(["listremotes"])?;
        Ok(output
            .lines()
            .map(|line| line.trim().trim_end_matches(':').to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    fn create_google_drive_remote(&self) -> Result<(), String> {
        self.run([
            "config",
            "create",
            DEFAULT_REMOTE_NAME,
            "drive",
            "scope",
            "drive",
            "config_is_local",
            "true",
            "--non-interactive",
            "--auto-confirm",
        ])
        .map(|_| ())
    }

    fn delete_remote(&self, remote: &str) -> Result<(), String> {
        self.run(["config", "delete", remote]).map(|_| ())
    }

    fn ensure_remote_folder_named(&self, remote: &str, remote_path: &str) -> Result<(), String> {
        self.run_retrying_transient(["mkdir", &remote_spec_parts(remote, remote_path)])
            .map(|_| ())
    }

    fn run<I, S>(&self, args: I) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        self.run_with_timeout(args, RCLONE_COMMAND_TIMEOUT)
    }

    fn run_retrying_transient<I, S>(&self, args: I) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = args
            .into_iter()
            .map(|arg| arg.as_ref().to_os_string())
            .collect::<Vec<_>>();
        let delays = retry_delays();
        let mut last_error = String::new();
        for attempt in 0..=delays.len() {
            match self.run(args.iter().map(OsString::as_os_str)) {
                Ok(output) => return Ok(output),
                Err(error) if is_transient_cloud_error(&error) => {
                    last_error = error;
                    if let Some(delay) = delays.get(attempt).copied() {
                        std::thread::sleep(delay);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error)
    }

    fn run_with_timeout<I, S>(&self, args: I, timeout: Duration) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        if let Some(parent) = self.config.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let stdout_path = temp_output_path("stdout");
        let stderr_path = temp_output_path("stderr");
        let stdout = std::fs::File::create(&stdout_path).map_err(|e| e.to_string())?;
        let stderr = std::fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
        let mut child = std::process::Command::new(&self.binary)
            .arg("--config")
            .arg(&self.config)
            .args([
                "--contimeout",
                "20s",
                "--timeout",
                "90s",
                "--retries",
                "2",
                "--low-level-retries",
                "2",
                "--transfers",
                "4",
                "--checkers",
                "4",
            ])
            .args(args)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|e| format!("could not run rclone: {e}"))?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stderr = read_and_remove_output(&stderr_path);
                    let stdout = read_and_remove_output(&stdout_path);
                    let detail = if stderr.trim().is_empty() {
                        stdout
                    } else {
                        stderr
                    };
                    return Err(format!(
                        "rclone timed out after {}s: {}",
                        timeout.as_secs(),
                        truncate_for_status(&detail)
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = read_and_remove_output(&stderr_path);
                    let _ = read_and_remove_output(&stdout_path);
                    return Err(format!("could not wait for rclone: {error}"));
                }
            }
        };
        let stdout = read_and_remove_output(&stdout_path);
        let stderr = read_and_remove_output(&stderr_path);
        if status.success() {
            return Ok(stdout);
        }
        Err(format!("rclone failed: {}", truncate_for_status(&stderr)))
    }
}

impl CloudConnector for DesktopRcloneConnector {
    fn ensure_remote_folder(&self, config: &CloudSyncConfig) -> Result<(), String> {
        self.run_retrying_transient(["mkdir", &remote_spec(config)])
            .map(|_| ())
    }

    fn pull(&self, config: &CloudSyncConfig, staging: &Path) -> Result<(), String> {
        std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;
        let staging = staging.to_string_lossy().into_owned();
        self.run([
            "copy",
            &remote_spec(config),
            &staging,
            "--create-empty-src-dirs",
            "--exclude",
            ".wordhunter-health-*.tmp",
            "--exclude",
            "*.tmp",
        ])
        .map(|_| ())
    }

    fn push(&self, config: &CloudSyncConfig, local_sync_dir: &Path) -> Result<(), String> {
        let local_sync_dir = local_sync_dir.to_string_lossy().into_owned();
        self.run([
            "copy",
            &local_sync_dir,
            &remote_spec(config),
            "--create-empty-src-dirs",
            "--exclude",
            ".wordhunter-health-*.tmp",
            "--exclude",
            "sync-staging/**",
            "--exclude",
            "*.tmp",
        ])
        .map(|_| ())
    }
}

#[cfg(not(target_os = "android"))]
fn run_sync(
    store: &Store,
    connector: &impl CloudConnector,
    config: &CloudSyncConfig,
) -> Result<Value, String> {
    write_status(status_value(
        "syncing_pull",
        Some(config),
        Some("Preparing cloud folder."),
        Some("remote"),
    ))?;
    connector.ensure_remote_folder(config)?;

    let staging = staging_dir(store)?;
    write_status(status_value(
        "syncing_pull",
        Some(config),
        Some("Downloading cloud copy into staging."),
        Some("pull"),
    ))?;
    connector.pull(config, &staging)?;

    write_status(status_value(
        "validating",
        Some(config),
        Some("Validating staged records."),
        Some("validate"),
    ))?;
    validate_sync_folder(&staging)?;

    write_status(status_value(
        "merging",
        Some(config),
        Some("Merging staged records."),
        Some("merge"),
    ))?;
    let _ = store.sync_with_directory(staging)?;

    let managed = crate::sync_assistant::managed_sync_dir()?;
    let mut snapshot = store.sync_with_directory(managed.clone())?;
    crate::paths::set_sync_dir(crate::APP_NAME, &managed)?;
    snapshot["syncDir"] = Value::String(managed.to_string_lossy().into_owned());
    write_marker(&managed, config)?;

    write_status(status_value(
        "syncing_push",
        Some(config),
        Some("Uploading local sync folder to cloud copy."),
        Some("push"),
    ))?;
    connector.push(config, &managed)?;

    let health = crate::sync_assistant::folder_health(&managed);
    write_status(status_value(
        "complete",
        Some(config),
        Some("Cloud sync complete."),
        Some("complete"),
    ))?;
    Ok(json!({
        "snapshot": snapshot,
        "health": health,
        "status": load_status().unwrap_or_else(|| status_value("complete", Some(config), None, None)),
    }))
}

fn validate_sync_folder(dir: &Path) -> Result<(), String> {
    let health = crate::sync_assistant::folder_health(dir);
    let issues = health
        .get("issueCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if issues > 0 {
        return Err(format!(
            "staged cloud copy has {issues} file issue(s); local data was not overwritten"
        ));
    }
    Ok(())
}

fn staging_dir(store: &Store) -> Result<PathBuf, String> {
    let dir = store
        .dir()
        .join("sync-staging")
        .join("cloud-runs")
        .join(format!("{}-{}", now_millis(), std::process::id()))
        .join("incoming");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_marker(dir: &Path, config: &CloudSyncConfig) -> Result<(), String> {
    let marker_dir = dir.join(MARKER_DIR);
    std::fs::create_dir_all(&marker_dir).map_err(|e| e.to_string())?;
    let marker = json!({
        "schemaVersion": 1,
        "app": "WordHunter",
        "folderKind": "wordhunter-sync",
        "createdAt": now_label(),
        "provider": config.provider,
        "remote": remote_spec(config),
        "recordFormat": "records/v1",
    });
    write_json_atomically(&marker_dir.join(MARKER_FILE), &marker)
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn load_config() -> Result<Option<CloudSyncConfig>, String> {
    let Some(raw) = crate::paths::read_app_config(crate::APP_NAME, CONFIG_SUFFIX)? else {
        return Ok(None);
    };
    let config: CloudSyncConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if config.schema_version > CONFIG_SCHEMA_VERSION {
        return Err(format!(
            "unsupported cloud sync config schema {}",
            config.schema_version
        ));
    }
    Ok(Some(config))
}

fn save_config(config: &CloudSyncConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    crate::paths::write_app_config(crate::APP_NAME, CONFIG_SUFFIX, &bytes)
}

fn clear_config() -> Result<(), String> {
    let path = crate::paths::app_config_path(crate::APP_NAME, CONFIG_SUFFIX)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn load_status() -> Option<Value> {
    let raw = crate::paths::read_app_config(crate::APP_NAME, STATUS_SUFFIX)
        .ok()
        .flatten()?;
    serde_json::from_str(&raw).ok()
}

fn write_status(status: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&status).map_err(|e| e.to_string())?;
    crate::paths::write_app_config(crate::APP_NAME, STATUS_SUFFIX, &bytes)
}

fn status_value(
    status: &str,
    config: Option<&CloudSyncConfig>,
    message: Option<&str>,
    stage: Option<&str>,
) -> Value {
    let mut value = json!({
        "schemaVersion": STATUS_SCHEMA_VERSION,
        "status": status,
        "updatedAt": now_label(),
    });
    if let Some(config) = config {
        value["configured"] = Value::Bool(true);
        value["provider"] = Value::String(config.provider.clone());
        value["remote"] = Value::String(remote_spec(config));
        value["remotePath"] = Value::String(config.remote_path.clone());
    }
    if let Some(message) = message {
        value["message"] = Value::String(message.to_string());
    }
    if let Some(stage) = stage {
        value["stage"] = Value::String(stage.to_string());
    }
    value
}

fn remote_spec(config: &CloudSyncConfig) -> String {
    remote_spec_parts(&config.remote, &config.remote_path)
}

fn remote_spec_parts(remote: &str, remote_path: &str) -> String {
    format!(
        "{}:{}",
        remote.trim_end_matches(':'),
        remote_path.trim_start_matches('/')
    )
}

fn should_retry_authorization(error: &str) -> bool {
    is_authorization_error(error)
        || is_transient_cloud_error(error)
        || error_contains_any(
            error,
            &[
                "didn't find section in config file",
                "did not find section in config file",
                "not found in config file",
                "not configured",
                "could not find remote",
            ],
        )
}

fn retry_delays() -> Vec<Duration> {
    if std::env::var_os("WORDHUNTER_RCLONE_FAST_RETRY").is_some() {
        return vec![Duration::from_millis(10), Duration::from_millis(10)];
    }
    RCLONE_RETRY_DELAYS.to_vec()
}

fn is_transient_cloud_error(error: &str) -> bool {
    error_contains_any(
        error,
        &[
            "quota exceeded",
            "rate limit",
            "ratelimitexceeded",
            "userratelimitexceeded",
            "defaultperminuteperproject",
            "backend error",
            "backenderror",
            "service unavailable",
            "temporarily unavailable",
            "too many requests",
            "try again",
            "deadline exceeded",
        ],
    )
}

fn is_authorization_error(error: &str) -> bool {
    error_contains_any(
        error,
        &[
            "access_denied",
            "authorization",
            "authorize",
            "cancelled",
            "canceled",
            "couldn't fetch token",
            "failed to get token",
            "invalid credentials",
            "invalid_grant",
            "oauth",
            "oauth2",
            "token",
            "unauthorized",
            "unauthenticated",
        ],
    )
}

fn error_contains_any(error: &str, needles: &[&str]) -> bool {
    let error = error.to_ascii_lowercase();
    needles.iter().any(|needle| error.contains(needle))
}

fn authorization_failure_message(error: &str) -> String {
    if is_authorization_error(error) {
        "Google Drive authorization did not complete. Click Connect Google Drive again and finish the browser sign-in.".to_string()
    } else {
        format!("Google Drive connector failed: {error}")
    }
}

fn bundled_rclone_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from("/app/bin/rclone"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(if cfg!(target_os = "windows") {
                "rclone.exe"
            } else {
                "rclone"
            }));
        }
    }
    candidates
}

fn rclone_config_path() -> Result<PathBuf, String> {
    crate::paths::app_config_path(crate::APP_NAME, RCLONE_CONFIG_SUFFIX)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn now_label() -> String {
    now_millis().to_string()
}

fn temp_output_path(kind: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wordhunter-rclone-{}-{}-{kind}.log",
        std::process::id(),
        now_millis()
    ))
}

fn read_and_remove_output(path: &Path) -> String {
    let value = std::fs::read_to_string(path).unwrap_or_default();
    let _ = std::fs::remove_file(path);
    value
}

fn truncate_for_status(value: &str) -> String {
    const MAX: usize = 600;
    let value = value.trim();
    if value.len() <= MAX {
        value.to_string()
    } else {
        format!("{}...[truncated]", &value[..MAX])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::{Map, json};
    use std::ffi::OsString;

    struct FakeConnector {
        remote: tempfile::TempDir,
    }

    impl Default for FakeConnector {
        fn default() -> Self {
            Self {
                remote: tempfile::tempdir().unwrap(),
            }
        }
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: tests hold TEST_ENV_LOCK while overriding process env.
            unsafe { std::env::set_var(key, value) };
            Self { key, previous }
        }

        fn set_value(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: tests hold TEST_ENV_LOCK while overriding process env.
            unsafe { std::env::set_var(key, value) };
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: tests hold TEST_ENV_LOCK while overriding process env.
            unsafe { std::env::remove_var(key) };
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                // SAFETY: tests hold TEST_ENV_LOCK while restoring process env.
                unsafe { std::env::set_var(self.key, previous) };
            } else {
                // SAFETY: tests hold TEST_ENV_LOCK while restoring process env.
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    impl CloudConnector for FakeConnector {
        fn ensure_remote_folder(&self, _config: &CloudSyncConfig) -> Result<(), String> {
            Ok(())
        }

        fn pull(&self, _config: &CloudSyncConfig, staging: &Path) -> Result<(), String> {
            copy_tree(self.remote.path(), staging)
        }

        fn push(&self, _config: &CloudSyncConfig, local_sync_dir: &Path) -> Result<(), String> {
            copy_tree(local_sync_dir, self.remote.path())
        }
    }

    fn profile_payload(word: &str, translation: &str) -> Value {
        let mut vocab = Map::new();
        vocab.insert(
            word.to_string(),
            json!({ "word": word, "translation": translation, "status": "learning" }),
        );
        json!({
            "texts": [],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": {
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": vocab
                }
            }
        })
    }

    #[test]
    fn validates_staging_before_merge() {
        let staging = tempfile::tempdir().unwrap();
        let bad = staging.path().join("records/v1/prefs/bad.json");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(bad, "{").unwrap();

        let error = validate_sync_folder(staging.path()).unwrap_err();

        assert!(error.contains("local data was not overwritten"));
    }

    #[test]
    fn connector_flow_merges_remote_and_pushes_marker_without_remote_delete() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
        let _xdg_data = EnvGuard::unset("XDG_DATA_HOME");
        let store = Store::new(crate::APP_NAME).unwrap();
        store.bulk_save(profile_payload("lokal", "local")).unwrap();

        let connector = FakeConnector::default();
        let remote_records = crate::store::record_files::payload_to_records(
            &profile_payload("cloud", "remote"),
            "remote-device",
            1,
        );
        crate::store::record_files::write_records(connector.remote.path(), &remote_records)
            .unwrap();
        std::fs::write(connector.remote.path().join("keep.txt"), "do-not-delete").unwrap();
        let config = CloudSyncConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            provider: "fake".to_string(),
            remote: "fake".to_string(),
            remote_path: DEFAULT_REMOTE_PATH.to_string(),
            connected_at: now_label(),
        };

        let result = run_sync(&store, &connector, &config).unwrap();

        assert_eq!(
            result["snapshot"]["vocab"]["de"]["vocab"]["lokal"]["translation"],
            "local"
        );
        assert_eq!(
            result["snapshot"]["vocab"]["de"]["vocab"]["cloud"]["translation"],
            "remote"
        );
        assert!(connector.remote.path().join("keep.txt").is_file());
        assert!(
            home.path()
                .join("Documents/WordHunterSync/.wordhunter-sync/manifest.json")
                .is_file()
        );
    }

    #[test]
    #[cfg(unix)]
    fn connect_google_drive_creates_default_remote_when_missing() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let fake = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());

        let state_file = fake.path().join("remote-created");
        let script = fake.path().join("rclone");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
set -eu
last_command=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "listremotes" ]; then
    if [ -f "{state}" ]; then
      printf 'wordhunter-drive:\n'
    fi
    exit 0
  fi
	  if [ "$1" = "config" ] && [ "${{2:-}}" = "create" ] && [ "${{3:-}}" = "wordhunter-drive" ]; then
	    touch "{state}"
	    printf '{{"State":"","Option":null,"Error":"","Result":""}}\n'
	    exit 0
	  fi
	  if [ "$1" = "mkdir" ]; then
	    exit 0
	  fi
	  last_command="$1"
	  shift
	done
echo "unexpected args after $last_command" >&2
exit 1
"#,
                state = state_file.display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let _rclone = EnvGuard::set("WORDHUNTER_RCLONE", &script);

        let status = CloudSync::new().connect_google_drive().unwrap();

        assert_eq!(status["configured"], true);
        assert_eq!(status["remote"], "wordhunter-drive:WordHunterSync");
        assert!(state_file.is_file());
        assert!(
            crate::paths::app_config_path(crate::APP_NAME, RCLONE_CONFIG_SUFFIX)
                .unwrap()
                .starts_with(appdata.path())
        );
    }

    #[test]
    #[cfg(unix)]
    fn connect_google_drive_cleans_partial_remote_after_cancelled_auth() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let fake = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());

        let partial = fake.path().join("partial-remote");
        let deleted = fake.path().join("deleted-remote");
        let script = fake.path().join("rclone");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
set -eu
last_command=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "listremotes" ]; then
    exit 0
  fi
  if [ "$1" = "config" ] && [ "${{2:-}}" = "create" ] && [ "${{3:-}}" = "wordhunter-drive" ]; then
    touch "{partial}"
    echo "failed to get token: context canceled" >&2
    exit 1
  fi
  if [ "$1" = "config" ] && [ "${{2:-}}" = "delete" ] && [ "${{3:-}}" = "wordhunter-drive" ]; then
    touch "{deleted}"
    exit 0
  fi
  last_command="$1"
  shift
done
echo "unexpected args after $last_command" >&2
exit 1
"#,
                partial = partial.display(),
                deleted = deleted.display(),
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let _rclone = EnvGuard::set("WORDHUNTER_RCLONE", &script);

        let cloud = CloudSync::new();
        let error = cloud.connect_google_drive().unwrap_err();
        let status = cloud.status();

        assert!(error.contains("Connect Google Drive again"));
        assert_eq!(status["configured"], false);
        assert_eq!(status["status"], "auth_required");
        assert!(partial.is_file());
        assert!(deleted.is_file());
        assert!(
            !crate::paths::app_config_path(crate::APP_NAME, CONFIG_SUFFIX)
                .unwrap()
                .exists()
        );
    }

    #[test]
    #[cfg(unix)]
    fn connect_google_drive_recreates_broken_default_remote_on_retry() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let fake = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());

        let recreated = fake.path().join("recreated-remote");
        let deleted = fake.path().join("deleted-remote");
        let script = fake.path().join("rclone");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
set -eu
last_command=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "listremotes" ]; then
    printf 'wordhunter-drive:\n'
    exit 0
  fi
  if [ "$1" = "mkdir" ]; then
    if [ -f "{recreated}" ]; then
      exit 0
    fi
    echo "invalid_grant: token has been expired or revoked" >&2
    exit 1
  fi
  if [ "$1" = "config" ] && [ "${{2:-}}" = "delete" ] && [ "${{3:-}}" = "wordhunter-drive" ]; then
    touch "{deleted}"
    exit 0
  fi
  if [ "$1" = "config" ] && [ "${{2:-}}" = "create" ] && [ "${{3:-}}" = "wordhunter-drive" ]; then
    touch "{recreated}"
    exit 0
  fi
  last_command="$1"
  shift
done
echo "unexpected args after $last_command" >&2
exit 1
"#,
                recreated = recreated.display(),
                deleted = deleted.display(),
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let _rclone = EnvGuard::set("WORDHUNTER_RCLONE", &script);

        let status = CloudSync::new().connect_google_drive().unwrap();

        assert_eq!(status["configured"], true);
        assert_eq!(status["status"], "ready");
        assert_eq!(status["remote"], "wordhunter-drive:WordHunterSync");
        assert!(deleted.is_file());
        assert!(recreated.is_file());
    }

    #[test]
    #[cfg(unix)]
    fn connect_google_drive_retries_transient_google_quota_error() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let fake = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
        let _fast_retry = EnvGuard::set_value("WORDHUNTER_RCLONE_FAST_RETRY", "1");

        let first_failure = fake.path().join("first-quota-failure");
        let script = fake.path().join("rclone");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/sh
set -eu
last_command=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "listremotes" ]; then
    printf 'wordhunter-drive:\n'
    exit 0
  fi
  if [ "$1" = "mkdir" ]; then
    if [ ! -f "{first_failure}" ]; then
      touch "{first_failure}"
      echo "googleapi: Error 403: Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'" >&2
      exit 1
    fi
    exit 0
  fi
  last_command="$1"
  shift
done
echo "unexpected args after $last_command" >&2
exit 1
"#,
                first_failure = first_failure.display(),
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let _rclone = EnvGuard::set("WORDHUNTER_RCLONE", &script);

        let status = CloudSync::new().connect_google_drive().unwrap();

        assert_eq!(status["configured"], true);
        assert_eq!(status["status"], "ready");
        assert_eq!(status["remote"], "wordhunter-drive:WordHunterSync");
        assert!(first_failure.is_file());
        assert!(
            crate::paths::app_config_path(crate::APP_NAME, CONFIG_SUFFIX)
                .unwrap()
                .exists()
        );
    }

    #[test]
    fn auth_required_status_disables_configured_cloud_sync() {
        let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let appdata = tempfile::tempdir().unwrap();
        let xdg_config = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let _appdata = EnvGuard::set("APPDATA", appdata.path());
        let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
        let config = CloudSyncConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            provider: "rclone".to_string(),
            remote: DEFAULT_REMOTE_NAME.to_string(),
            remote_path: DEFAULT_REMOTE_PATH.to_string(),
            connected_at: now_label(),
        };
        save_config(&config).unwrap();
        write_status(status_value(
            "auth_required",
            Some(&config),
            Some("sign in again"),
            Some("auth"),
        ))
        .unwrap();

        let status = CloudSync::new().status();

        assert_eq!(status["status"], "auth_required");
        assert_eq!(status["configured"], false);
        assert!(status.get("remote").is_none());
    }

    #[test]
    #[cfg(unix)]
    fn rclone_run_times_out_instead_of_hanging_forever() {
        let fake = tempfile::tempdir().unwrap();
        let script = fake.path().join("rclone");
        std::fs::write(
            &script,
            r#"#!/bin/sh
sleep 5
echo "late"
"#,
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }
        let connector = DesktopRcloneConnector {
            binary: script,
            config: fake.path().join("rclone.conf"),
        };

        let error = connector
            .run_with_timeout(["listremotes"], Duration::from_millis(100))
            .unwrap_err();

        assert!(error.contains("timed out"));
    }

    fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            let target = to.join(entry.file_name());
            if source.is_dir() {
                copy_tree(&source, &target)?;
            } else {
                std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
