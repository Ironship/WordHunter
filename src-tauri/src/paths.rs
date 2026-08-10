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

fn appdata_dir() -> Option<PathBuf> {
    env_path("APPDATA")
}

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

fn default_data_dir(app_name: &str) -> Result<PathBuf, String> {
    if let Some(appdata) = appdata_dir() {
        return Ok(appdata.join(app_name));
    }

    xdg_data_dir()
        .map(|base| base.join(app_name))
        .ok_or_else(|| "could not locate user data directory".to_string())
}

pub fn data_dir(app_name: &str) -> Result<PathBuf, String> {
    let default = default_data_dir(app_name)?;
    let dir = match read_config_file(app_name, "data-dir")? {
        Some(value) => {
            let dir = PathBuf::from(value.trim());
            if dir.as_os_str().is_empty() {
                default
            } else if dir.is_dir() {
                dir
            } else {
                // The user-chosen folder no longer exists (it was deleted,
                // moved, or sits on a detached drive). Falling back to the
                // default data folder keeps the app launchable, and the stale
                // pointer is cleared so the next start does not hit the same
                // dead end. The user can re-select a folder in Settings.
                let _ = write_config_file(app_name, "data-dir", &[]);
                default
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
