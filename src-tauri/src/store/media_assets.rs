use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use super::{durable, record_files};

const MANIFEST_SCHEMA_VERSION: u64 = 1;
pub(crate) const IMPORT_PENDING_MARKER: &str = ".ocr-import-pending";

#[derive(Clone, Debug, Eq, PartialEq)]
struct AssetEntry {
    path: String,
    hash: String,
    size: u64,
    updated_at: u128,
    deleted_at: Option<u128>,
    device_id: String,
}

type Manifest = BTreeMap<String, AssetEntry>;

pub(crate) fn record_saved_book_asset(
    root: &Path,
    book_id: &str,
    img_name: &str,
    data: &[u8],
    device_id: &str,
) -> Result<(), String> {
    let mut manifest = load_manifest(root)?;
    let path = book_image_relative_path(book_id, img_name);
    let now = record_files::now_millis();
    manifest.insert(
        path.clone(),
        AssetEntry {
            path,
            hash: content_hash_bytes(data),
            size: data.len() as u64,
            updated_at: now,
            deleted_at: None,
            device_id: device_id.to_string(),
        },
    );
    write_manifest(root, &manifest)
}

pub(crate) fn tombstone_book_assets(
    root: &Path,
    book_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let mut manifest = refresh_book_manifest(root, device_id)?;
    let prefix = format!("books/{book_id}/");
    let now = record_files::now_millis();
    for entry in manifest
        .values_mut()
        .filter(|entry| entry.path.starts_with(&prefix))
    {
        entry.deleted_at = Some(now);
        entry.updated_at = now;
        entry.device_id = device_id.to_string();
    }
    write_manifest(root, &manifest)
}

pub(crate) fn tombstone_all(root: &Path, device_id: &str) -> Result<(), String> {
    let mut manifest = refresh_book_manifest(root, device_id)?;
    let now = record_files::now_millis();
    for entry in manifest.values_mut() {
        entry.deleted_at = Some(now);
        entry.updated_at = now;
        entry.device_id = device_id.to_string();
        let path = safe_join(root, &entry.path)?;
        durable::remove_file_if_exists(&path)?;
    }
    write_manifest(root, &manifest)
}

pub(crate) fn sync_book_assets(
    local_root: &Path,
    remote_root: &Path,
    device_id: &str,
) -> Result<(), String> {
    let local = refresh_book_manifest(local_root, device_id)?;
    let remote = refresh_book_manifest(remote_root, device_id)?;
    let merged = merge_manifests(local, remote);
    apply_manifest(local_root, remote_root, &merged)?;
    apply_manifest(remote_root, local_root, &merged)?;
    write_manifest(local_root, &merged)?;
    write_manifest(remote_root, &merged)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn merge_book_assets_into(
    source_root: &Path,
    target_root: &Path,
    device_id: &str,
) -> Result<(), String> {
    let source = refreshed_book_manifest(source_root, device_id)?;
    let target = refresh_book_manifest(target_root, device_id)?;
    let merged = merge_manifests(source, target);
    apply_manifest(target_root, source_root, &merged)?;
    write_manifest(target_root, &merged)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn validate_imported_book_assets(
    root: &Path,
    final_book_id: &str,
) -> Result<(), String> {
    let images = root.join("books").join(final_book_id).join("images");
    let mut files = Vec::new();
    collect_asset_files(&images, &mut files)?;
    if files.is_empty() {
        return Err("finalized PDF import has no media assets".to_string());
    }
    Ok(())
}

pub(crate) fn finalize_imported_book_assets(
    root: &Path,
    final_book_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let images = root.join("books").join(final_book_id).join("images");
    let mut files = Vec::new();
    collect_asset_files(&images, &mut files)?;
    if files.is_empty() {
        return Err("finalized PDF import has no media assets".to_string());
    }
    let mut manifest = refreshed_book_manifest(root, device_id)?;
    update_manifest_from_files(root, &files, &mut manifest, device_id)?;
    write_manifest(root, &manifest)
}

pub(crate) fn discard_imported_book_assets(
    root: &Path,
    book_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let mut manifest = refreshed_book_manifest(root, device_id)?;
    let prefix = format!("books/{book_id}/");
    manifest.retain(|path, _| !path.starts_with(&prefix));
    write_manifest(root, &manifest)
}

fn refresh_book_manifest(root: &Path, device_id: &str) -> Result<Manifest, String> {
    let manifest = refreshed_book_manifest(root, device_id)?;
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

fn refreshed_book_manifest(root: &Path, device_id: &str) -> Result<Manifest, String> {
    let mut manifest = load_manifest(root)?;
    let files = list_book_asset_files(root)?;
    update_manifest_from_files(root, &files, &mut manifest, device_id)?;
    Ok(manifest)
}

fn update_manifest_from_files(
    root: &Path,
    files: &[PathBuf],
    manifest: &mut Manifest,
    device_id: &str,
) -> Result<(), String> {
    let now = record_files::now_millis();
    for file in files {
        let relative = display_relative(root, file)?;
        let hash = content_hash_file(file)?;
        let size = std::fs::metadata(file)
            .map_err(|e| format!("could not stat {}: {e}", file.display()))?
            .len();
        match manifest.get_mut(&relative) {
            Some(entry) if entry.deleted_at.is_some() => {}
            Some(entry) if entry.hash == hash && entry.size == size => {}
            Some(entry) => {
                entry.hash = hash;
                entry.size = size;
                entry.updated_at = now;
                entry.deleted_at = None;
                entry.device_id = device_id.to_string();
            }
            None => {
                manifest.insert(
                    relative.clone(),
                    AssetEntry {
                        path: relative,
                        hash,
                        size,
                        updated_at: now,
                        deleted_at: None,
                        device_id: device_id.to_string(),
                    },
                );
            }
        }
    }
    Ok(())
}

fn merge_manifests(left: Manifest, right: Manifest) -> Manifest {
    let mut merged = left;
    for (path, incoming) in right {
        match merged.get(&path) {
            Some(current) if should_keep_asset(current, &incoming) => {}
            _ => {
                merged.insert(path, incoming);
            }
        }
    }
    merged
}

fn should_keep_asset(current: &AssetEntry, incoming: &AssetEntry) -> bool {
    let current_time = asset_time(current);
    let incoming_time = asset_time(incoming);
    if current_time != incoming_time {
        return current_time > incoming_time;
    }
    if current.deleted_at.is_some() != incoming.deleted_at.is_some() {
        return current.deleted_at.is_some();
    }
    if current.device_id != incoming.device_id {
        return current.device_id > incoming.device_id;
    }
    current.hash >= incoming.hash
}

fn asset_time(entry: &AssetEntry) -> u128 {
    entry
        .deleted_at
        .unwrap_or(entry.updated_at)
        .max(entry.updated_at)
}

fn apply_manifest(
    target_root: &Path,
    source_root: &Path,
    manifest: &Manifest,
) -> Result<(), String> {
    for entry in manifest.values() {
        let target = safe_join(target_root, &entry.path)?;
        if entry.deleted_at.is_some() {
            durable::remove_file_if_exists(&target)?;
            continue;
        }
        let target_hash = if target.is_file() {
            Some(content_hash_file(&target)?)
        } else {
            None
        };
        if target_hash.as_deref() == Some(entry.hash.as_str()) {
            continue;
        }
        let source = safe_join(source_root, &entry.path)?;
        if source.is_file() && content_hash_file(&source)? == entry.hash {
            durable::copy_file_atomic(&source, &target, false)?;
        }
    }
    Ok(())
}

fn load_manifest(root: &Path) -> Result<Manifest, String> {
    let path = manifest_path(root);
    durable::recover_replace(&path)?;
    if !path.exists() {
        return Ok(Manifest::new());
    }
    let value = read_manifest_value(&path)?;
    parse_manifest(&value)
}

fn write_manifest(root: &Path, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(root);
    durable::write_json_atomic(&path, &manifest_value(manifest), true, true)
}

fn read_manifest_value(path: &Path) -> Result<Value, String> {
    let primary = std::fs::read(path)
        .map_err(|e| format!("could not read media manifest {}: {e}", path.display()))
        .and_then(|raw| {
            serde_json::from_slice::<Value>(&raw)
                .map_err(|e| format!("media manifest {} is corrupt: {e}", path.display()))
        });
    match primary {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let backup = path.with_extension("bak");
            if !backup.exists() {
                return Err(primary_error);
            }
            let raw = std::fs::read(&backup)
                .map_err(|e| format!("{primary_error}; backup {}: {e}", backup.display()))?;
            serde_json::from_slice::<Value>(&raw).map_err(|e| {
                format!(
                    "{primary_error}; backup {} is corrupt: {e}",
                    backup.display()
                )
            })
        }
    }
}

fn parse_manifest(value: &Value) -> Result<Manifest, String> {
    if value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        != MANIFEST_SCHEMA_VERSION
    {
        return Err("unsupported media manifest schemaVersion".to_string());
    }
    let mut manifest = Manifest::new();
    let Some(assets) = value.get("assets").and_then(Value::as_object) else {
        return Ok(manifest);
    };
    for (path, value) in assets {
        let entry = AssetEntry {
            path: path.clone(),
            hash: value
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
            updated_at: parse_time(value.get("updatedAt")),
            deleted_at: value.get("deletedAt").and_then(|value| {
                if value.is_null() {
                    None
                } else {
                    Some(parse_time(Some(value)))
                }
            }),
            device_id: value
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        };
        if entry.hash.is_empty() && entry.deleted_at.is_none() {
            continue;
        }
        manifest.insert(path.clone(), entry);
    }
    Ok(manifest)
}

fn manifest_value(manifest: &Manifest) -> Value {
    let assets = manifest
        .iter()
        .map(|(path, entry)| {
            (
                path.clone(),
                json!({
                    "hash": entry.hash,
                    "size": entry.size,
                    "updatedAt": entry.updated_at.to_string(),
                    "deletedAt": entry.deleted_at.map(|value| value.to_string()),
                    "deviceId": entry.device_id,
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "assets": assets,
    })
}

fn manifest_path(root: &Path) -> PathBuf {
    record_files::records_root(root)
        .join("assets")
        .join("media-manifest.json")
}

fn list_book_asset_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let books = root.join("books");
    let mut files = Vec::new();
    if !books.exists() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(&books).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "book asset path cannot be a symlink: {}",
                entry.path().display()
            ));
        }
        let book_dir = entry.path();
        if file_type.is_dir() {
            if book_dir.join(IMPORT_PENDING_MARKER).exists() {
                continue;
            }
            collect_asset_files(&book_dir.join("images"), &mut files)?;
        }
    }
    files.sort();
    Ok(files)
}

fn collect_asset_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("could not inspect {}: {error}", dir.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "book asset directory cannot be a symlink: {}",
            dir.display()
        ));
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if file_type.is_symlink() {
            return Err(format!(
                "book asset path cannot be a symlink: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_asset_files(&path, files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn book_image_relative_path(book_id: &str, img_name: &str) -> String {
    format!("books/{book_id}/images/{img_name}")
}

fn display_relative(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("asset path is outside root: {}", path.display()))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let Some(part) = part.to_str() else {
                    return Err("asset path is not UTF-8".to_string());
                };
                parts.push(part.to_string());
            }
            _ => return Err("asset path is invalid".to_string()),
        }
    }
    Ok(parts.join("/"))
}

pub(crate) fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => {
                path.push(part);
                match std::fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(format!(
                            "asset path cannot traverse a symlink: {}",
                            path.display()
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "could not inspect asset path {}: {error}",
                            path.display()
                        ));
                    }
                }
            }
            _ => return Err("asset path is invalid".to_string()),
        }
    }
    Ok(path)
}

fn content_hash_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("could not read asset {}: {e}", path.display()))?;
    let mut hash = 0xcbf29ce484222325_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("could not read asset {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hash = update_content_hash(hash, &buffer[..read]);
    }
    Ok(format!("{hash:016x}"))
}

fn content_hash_bytes(bytes: &[u8]) -> String {
    format!("{:016x}", update_content_hash(0xcbf29ce484222325, bytes))
}

fn update_content_hash(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn parse_time(value: Option<&Value>) -> u128 {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .or_else(|| value.and_then(Value::as_u64).map(u128::from))
        .unwrap_or(0)
}

#[cfg(all(test, unix))]
mod tests {
    use super::safe_join;

    #[test]
    fn safe_join_rejects_symlinked_asset_parents() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let images = root.path().join("books/book/images");
        std::fs::create_dir_all(&images).unwrap();
        symlink(outside.path(), images.join("linked")).unwrap();

        assert!(safe_join(root.path(), "books/book/images/linked/file.png").is_err());
    }
}
