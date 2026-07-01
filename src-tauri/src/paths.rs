use std::path::{Path, PathBuf};

fn base_dir() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| "could not locate user data directory".to_string())
}

pub fn data_dir(app_name: &str) -> Result<PathBuf, String> {
    let base = base_dir()?;
    let redirect = base.join(format!("{app_name}-data-dir.txt"));
    let dir = match std::fs::read_to_string(redirect) {
        Ok(value) => {
            let dir = PathBuf::from(value.trim());
            if dir.as_os_str().is_empty() {
                base.join(app_name)
            } else if dir.is_dir() {
                dir
            } else {
                return Err(format!(
                    "configured data folder is missing: {}",
                    dir.display()
                ));
            }
        }
        Err(_) => base.join(app_name),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(not(target_os = "android"))]
pub fn set_data_dir(app_name: &str, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = base_dir()?;
    std::fs::write(
        base.join(format!("{app_name}-data-dir.txt")),
        dir.to_string_lossy().as_bytes(),
    )
    .map_err(|e| e.to_string())
}

pub fn sync_dir(app_name: &str) -> Result<Option<PathBuf>, String> {
    let base = base_dir()?;
    let redirect = base.join(format!("{app_name}-sync-dir.txt"));
    let value = match std::fs::read_to_string(redirect) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let dir = PathBuf::from(value.trim());
    if dir.as_os_str().is_empty() {
        return Ok(None);
    }
    if !dir.is_dir() {
        return Err(format!(
            "configured sync folder is missing: {}",
            dir.display()
        ));
    }
    Ok(Some(dir))
}

#[cfg(not(target_os = "android"))]
pub fn set_sync_dir(app_name: &str, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = base_dir()?;
    std::fs::write(
        base.join(format!("{app_name}-sync-dir.txt")),
        dir.to_string_lossy().as_bytes(),
    )
    .map_err(|e| e.to_string())
}

pub fn device_id(app_name: &str) -> Result<String, String> {
    let base = base_dir()?;
    let path = base.join(format!("{app_name}-device-id.txt"));
    if let Ok(value) = std::fs::read_to_string(&path) {
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
    std::fs::write(path, id.as_bytes()).map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(not(target_os = "android"))]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn sanitize_id(id: &str) -> Result<String, String> {
    let path = Path::new(id);
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("invalid id".to_string());
    };
    if name.is_empty() || name == "." || name == ".." {
        return Err("invalid id".to_string());
    }
    Ok(name.to_string())
}

#[cfg(test)]
#[path = "tests/paths/tests.rs"]
mod tests;
