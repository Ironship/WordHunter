use std::path::{Path, PathBuf};

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    })
}

// APPDATA is a Windows concept; on Linux/macOS it is at best a Wine/Proton
// artifact and must never win over the XDG base directories (issue #135,
// bullet 1). Android is the one exception: platform/android.rs sets APPDATA
// from tauri's app_data_dir during setup (Android has neither XDG nor HOME
// for app processes), so the mobile build must honor it here.
// config_dir() and default_data_dir() both route their APPDATA lookup
// through this single gate, so no per-call-site cfg is needed.
#[cfg(any(windows, target_os = "android"))]
fn appdata_dir() -> Option<PathBuf> {
    env_path("APPDATA")
}

#[cfg(not(any(windows, target_os = "android")))]
fn appdata_dir() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn home_dir_path() -> Option<PathBuf> {
    env_path("HOME").or_else(|| {
        // Scrubbed environments (containers, service managers) may omit
        // $HOME; fall back to the passwd database via getpwuid with no
        // extra dependencies (issue #135, bullet 2). On unix
        // std::env::home_dir() checks $HOME first, then getpwuid.
        #[allow(deprecated)]
        std::env::home_dir()
    })
}

#[cfg(not(unix))]
fn home_dir_path() -> Option<PathBuf> {
    env_path("HOME")
}

fn xdg_config_dir() -> Option<PathBuf> {
    env_path("XDG_CONFIG_HOME").or_else(|| home_dir_path().map(|home| home.join(".config")))
}

fn xdg_data_dir() -> Option<PathBuf> {
    env_path("XDG_DATA_HOME").or_else(|| home_dir_path().map(|home| home.join(".local/share")))
}

pub(crate) fn config_dir() -> Result<PathBuf, String> {
    appdata_dir()
        .or_else(xdg_config_dir)
        .ok_or_else(|| "could not locate user config directory".to_string())
}

fn config_file_path(app_name: &str, suffix: &str) -> Result<PathBuf, String> {
    Ok(config_dir()?.join(format!("{app_name}-{suffix}.txt")))
}

fn read_config_file(app_name: &str, suffix: &str) -> Result<Option<String>, String> {
    let primary = config_file_path(app_name, suffix)?;
    crate::store::durable::recover_replace(&primary)?;
    match std::fs::read_to_string(&primary) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_config_file(app_name: &str, suffix: &str, bytes: &[u8]) -> Result<(), String> {
    let path = config_file_path(app_name, suffix)?;
    crate::store::durable::recover_replace(&path)?;
    crate::store::durable::write_file_atomic(&path, bytes, true)
}

// Pure, platform-agnostic resolution core: appdata (Windows native, or the
// APPDATA contract set by platform/android.rs) wins; otherwise the XDG data
// base (which already includes the HOME/.local/share fallback). Testable on
// every host so the Linux/macOS and Android shapes are both pinned.
pub(crate) fn resolve_default_data_dir(
    appdata: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
    app_name: &str,
) -> Result<PathBuf, String> {
    if let Some(appdata) = appdata {
        return Ok(appdata.join(app_name));
    }
    xdg_data
        .map(|base| base.join(app_name))
        .ok_or_else(|| "could not locate user data directory".to_string())
}

fn default_data_dir(app_name: &str) -> Result<PathBuf, String> {
    resolve_default_data_dir(appdata_dir(), xdg_data_dir(), app_name)
}

/// How to treat a stored data-dir pointer whose metadata could not be
/// obtained.
#[derive(Debug)]
enum DataDirPointer {
    /// The pointer is a real directory — keep using it.
    Use,
    /// The pointer is gone (deleted, moved, or on a detached drive) — clear
    /// it and fall back to the default data folder.
    Clear,
}

/// Classify a stored data-dir pointer from its metadata result so that a
/// permission error under confinement (flatpak/snap without filesystem
/// access) is never mistaken for a missing directory (issue #135, bullet 5).
fn classify_data_pointer(
    dir: &Path,
    metadata: Result<std::fs::Metadata, std::io::Error>,
) -> Result<DataDirPointer, String> {
    match metadata {
        Ok(metadata) if metadata.is_dir() => Ok(DataDirPointer::Use),
        Ok(_) => Ok(DataDirPointer::Clear),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DataDirPointer::Clear),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Err(format!(
            "data directory {} is not readable (permission denied); if the app is confined by \
             flatpak or snap, grant filesystem access, e.g. `flatpak override \
             --filesystem=home com.wordhunter.app` or `snap connect word-hunter:home`",
            dir.display()
        )),
        // Any other error keeps the historical behavior: fall back to the
        // default data folder.
        Err(_) => Ok(DataDirPointer::Clear),
    }
}

pub fn data_dir(app_name: &str) -> Result<PathBuf, String> {
    let default = default_data_dir(app_name)?;
    let dir = match read_config_file(app_name, "data-dir")? {
        Some(value) => {
            let dir = PathBuf::from(value.trim());
            if dir.as_os_str().is_empty() {
                default
            } else {
                match classify_data_pointer(&dir, std::fs::metadata(&dir))? {
                    DataDirPointer::Use => dir,
                    DataDirPointer::Clear => {
                        // The user-chosen folder no longer exists (it was
                        // deleted, moved, or sits on a detached drive).
                        // Falling back to the default data folder keeps the
                        // app launchable, and the stale pointer is cleared
                        // so the next start does not hit the same dead end.
                        // The user can re-select a folder in Settings.
                        let _ = write_config_file(app_name, "data-dir", &[]);
                        default
                    }
                }
            }
        }
        None => default,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(not(target_os = "android"))]
pub fn set_data_dir(app_name: &str, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_config_file(app_name, "data-dir", dir.to_string_lossy().as_bytes())
}

pub fn device_id(app_name: &str) -> Result<String, String> {
    if let Some(value) = read_config_file(app_name, "device-id")? {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.to_string());
        }
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let id = format!("{}-{}", std::process::id(), millis);
    write_config_file(app_name, "device-id", id.as_bytes())?;
    Ok(id)
}

pub fn sanitize_id(id: &str) -> Result<String, String> {
    if id.contains('/') || id.contains('\\') || id.contains(':') {
        return Err("invalid id".to_string());
    }
    let path = Path::new(id);
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("invalid id".to_string());
    };
    if name.is_empty() || name == "." || name == ".." || name != id {
        return Err("invalid id".to_string());
    }
    Ok(name.to_string())
}

#[cfg(test)]
#[path = "tests/paths/tests.rs"]
mod tests;
