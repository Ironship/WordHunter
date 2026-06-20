use std::path::{Path, PathBuf};

pub fn data_dir(app_name: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                std::env::var_os("HOME").map(|home| {
                    PathBuf::from(home).join("Library").join("Application Support")
                })
            }
            #[cfg(not(target_os = "macos"))]
            {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
            }
        })
        .ok_or_else(|| "could not locate user data directory".to_string())?;
    let dir = base.join(app_name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

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
