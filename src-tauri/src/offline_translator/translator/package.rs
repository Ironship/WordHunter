use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use zip::ZipArchive;

/// URL for the Argos Translate package index.
pub const ARGOS_PACKAGE_INDEX_URL: &str =
    "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json";
const MAX_PACKAGE_DOWNLOAD: u64 = 400_000_000;

/// Metadata for a single model package from the Argos index.
#[derive(Clone, Debug)]
pub(crate) struct ModelPackageInfo {
    pub from_code: String,
    pub to_code: String,
    pub package_type: String,
    pub links: Vec<String>,
}

/// Public install endpoint — downloads and extracts requested language pairs.
pub fn install(payload: Value) -> Result<Value, String> {
    let from_codes = json_string_array(payload.get("from"));
    let to_codes = json_string_array(payload.get("to"));
    let available = fetch_package_index()?;
    let mut installed = 0usize;
    let mut skipped = Vec::new();

    for from in from_codes {
        for to in &to_codes {
            if from == *to {
                continue;
            }
            let Some(pkg) = available.iter().find(|pkg| {
                pkg.package_type == "translate" && pkg.from_code == from && pkg.to_code == *to
            }) else {
                skipped.push(format!("{from}->{to}: not available"));
                continue;
            };
            if install_package(pkg)? {
                installed += 1;
            }
        }
    }

    Ok(json!({
        "success": true,
        "installed": installed,
        "skipped": skipped,
    }))
}

/// Collect all candidate directories where model packages may reside.
pub(crate) fn package_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = packages_dir() {
        roots.push(dir);
    }
    if let Some(legacy) = legacy_packages_dir() {
        roots.push(legacy);
    }
    roots
}

/// Return the primary (app-data) packages directory, creating it if needed.
fn packages_dir() -> Result<PathBuf, String> {
    let dir = crate::paths::data_dir(crate::APP_NAME)?.join("argos-packages");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Return the legacy Argos Translate packages directory, if it exists.
fn legacy_packages_dir() -> Option<PathBuf> {
    crate::paths::home_dir().map(|home| {
        home.join(".local")
            .join("share")
            .join("argos-translate")
            .join("packages")
    })
}

/// Fetch the Argos package index and return a list of available packages.
pub(crate) fn fetch_package_index() -> Result<Vec<ModelPackageInfo>, String> {
    let response = crate::http::agent()
        .get(ARGOS_PACKAGE_INDEX_URL)
        .set("User-Agent", crate::proxy::USER_AGENT)
        .call()
        .map_err(|e| e.to_string())?;
    let value = response.into_json::<Value>().map_err(|e| e.to_string())?;
    let packages = value
        .as_array()
        .ok_or_else(|| "model package index is not a JSON array".to_string())?
        .iter()
        .filter_map(parse_package_info)
        .collect::<Vec<_>>();
    Ok(packages)
}

/// Parse a single entry from the Argos package index into `ModelPackageInfo`.
fn parse_package_info(value: &Value) -> Option<ModelPackageInfo> {
    let links = value
        .get("links")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ModelPackageInfo {
        from_code: value.get("from_code")?.as_str()?.to_string(),
        to_code: value.get("to_code")?.as_str()?.to_string(),
        package_type: value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("translate")
            .to_string(),
        links,
    })
}

/// Download and extract a single model package.
fn install_package(pkg: &ModelPackageInfo) -> Result<bool, String> {
    use super::models::find_model_dir;

    if find_model_dir(&pkg.from_code, &pkg.to_code).is_some() {
        return Ok(false);
    }
    let target = packages_dir()?;
    let link = pkg.links.first().ok_or_else(|| {
        format!(
            "model package {}->{} has no download links",
            pkg.from_code, pkg.to_code
        )
    })?;
    let response = crate::http::agent()
        .get(link)
        .set("User-Agent", crate::proxy::USER_AGENT)
        .call()
        .map_err(|e| format!("failed to download {link}: {e}"))?;
    let mut data = Vec::new();
    response
        .into_reader()
        .take(MAX_PACKAGE_DOWNLOAD + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_PACKAGE_DOWNLOAD {
        return Err("model package is too large (max 400 MB)".to_string());
    }
    extract_package(&data, &target)?;
    Ok(true)
}

/// Extract a zip archive to the given target directory with size / entry limits.
fn extract_package(data: &[u8], target: &Path) -> Result<(), String> {
    const MAX_ENTRIES: usize = 2_000;
    const MAX_TOTAL_SIZE: u64 = 600_000_000;
    let staging = tempfile::tempdir_in(target).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(Cursor::new(data)).map_err(|e| e.to_string())?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "model package contains too many files (max {MAX_ENTRIES})"
        ));
    }

    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        total_size = total_size.saturating_add(file.size());
        if total_size > MAX_TOTAL_SIZE {
            return Err("model package is too large".to_string());
        }
        let Some(relative) = file.enclosed_name().map(PathBuf::from) else {
            return Err(format!("invalid path in model package: {}", file.name()));
        };
        let destination = staging.path().join(relative);
        if file.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = fs::File::create(&destination).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut output).map_err(|e| e.to_string())?;
    }
    let mut entries = fs::read_dir(staging.path())
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Err("model package must contain exactly one top-level directory".to_string());
    }
    let package = entries.pop().unwrap().path();
    let name = package
        .file_name()
        .ok_or_else(|| "invalid model package directory".to_string())?;
    let destination = target.join(name);
    if destination.exists() {
        return Err("model package already exists".to_string());
    }
    fs::rename(package, destination).map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract a JSON array of strings from an optional `Value`.
fn json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
