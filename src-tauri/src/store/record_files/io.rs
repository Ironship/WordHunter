use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::causal::{bump_causal, legacy_causal_clock, parse_causal};
use super::fingerprints::now_millis;
use super::merge::{canonicalize_vocab_records, tombstone_with_base};
use super::model::{FORMAT, PAYLOAD_SCHEMA_VERSION, SyncRecord, infer_kind, live_record};
use crate::store::durable;

const ROOT: &str = "records";
const VERSION: &str = "v1";
const RECORD_DIRS: [&str; 6] = ["profiles", "vocab", "texts", "prefs", "hidden", "books"];

pub(crate) fn records_root(dir: &Path) -> PathBuf {
    dir.join(ROOT).join(VERSION)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn has_records(dir: &Path) -> bool {
    let root = records_root(dir);
    RECORD_DIRS.iter().any(|name| root.join(name).is_dir())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn validate_records_layout(dir: &Path) -> Result<(), String> {
    let records = dir.join(ROOT);
    ensure_optional_dir(&records)?;
    if !records.exists() {
        return Ok(());
    }

    let root = records.join(VERSION);
    ensure_optional_dir(&root)?;
    if !root.exists() {
        return Ok(());
    }

    for name in RECORD_DIRS {
        ensure_optional_dir(&root.join(name))?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn ensure_optional_dir(path: &Path) -> Result<(), String> {
    if path.exists() && !path.is_dir() {
        return Err(format!(
            "configured data folder has a file where WordHunter needs a folder: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn load_records(dir: &Path) -> Result<BTreeMap<String, SyncRecord>, String> {
    let root = records_root(dir);
    let mut records = BTreeMap::new();
    if !root.exists() {
        return Ok(records);
    }
    for kind_dir in RECORD_DIRS {
        let dir = root.join(kind_dir);
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.contains(".sync-conflict-"))
            {
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str());
            let is_record = matches!(extension, Some("yaml" | "yml" | "json"));
            let is_backup = path.extension().and_then(|value| value.to_str()) == Some("bak");
            let path = if is_record {
                if extension == Some("json") && path.with_extension("yaml").exists() {
                    continue;
                }
                path
            } else if is_backup {
                let yaml = path.with_extension("yaml");
                let primary = if yaml.exists() {
                    yaml
                } else {
                    path.with_extension("json")
                };
                if primary.exists() {
                    continue;
                }
                path
            } else {
                continue;
            };
            match read_record_file(&path) {
                Ok(record) => {
                    // A recovery backup stands in for a missing primary; it
                    // must never override a live primary for the same key
                    // (an orphaned legacy FNV `.bak` from the SHA-256
                    // migration would otherwise roll fresh content back).
                    if is_backup && records.contains_key(&record.key) {
                        continue;
                    }
                    records.insert(record.key.clone(), record);
                }
                Err(error) => {
                    // Skip one bad record instead of killing startup; recovery status reports it.
                    eprintln!("{error}");
                }
            }
        }
    }
    Ok(canonicalize_vocab_records(records))
}

/// Cheap probe for the only thing `migrate_legacy_json_records` acts on: a
/// `*.json` record file. `read_dir` yields names without opening or parsing
/// anything, so an already-migrated store stops paying a full tree parse at
/// every start. The directories walked are a superset of the two the migration
/// itself tests, because `record_path` and `legacy_record_path` both resolve to
/// `records_root(dir).join(kind_dir(kind))`, and `kind_dir` returns either one
/// of `RECORD_DIRS` or the `"records"` fallback.
pub(crate) fn legacy_json_records_present(dir: &Path) -> bool {
    let root = records_root(dir);
    if !root.exists() {
        return false;
    }
    for kind_dir in RECORD_DIRS.iter().copied().chain(["records"]) {
        let Ok(entries) = std::fs::read_dir(root.join(kind_dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                return true;
            }
        }
    }
    false
}

pub(crate) fn migrate_legacy_json_records(dir: &Path) -> Result<usize, String> {
    let records = load_records(dir)?;
    let mut migrated = 0;
    for record in records.values() {
        let yaml = record_path(dir, record);
        let json = yaml.with_extension("json");
        let legacy_json = legacy_record_path(dir, record).with_extension("json");
        if !json.exists() && !legacy_json.exists() {
            continue;
        }
        write_record_with_backup(dir, record, true)?;
        read_record_file(&yaml)?;
        durable::remove_file_if_exists(&json)?;
        durable::remove_file_if_exists(&json.with_extension("bak"))?;
        migrated += 1;
    }
    Ok(migrated)
}

pub(crate) fn write_records(
    dir: &Path,
    records: &BTreeMap<String, SyncRecord>,
) -> Result<(), String> {
    for record in records.values() {
        write_record_with_backup(dir, record, true)?;
    }
    Ok(())
}

pub(crate) fn recovery_status(dir: &Path) -> Value {
    let record_problems = scan_record_problems(dir, 25);
    json!({
        "schemaVersion": 1,
        "skippedRecordCount": record_problems.total,
        "skippedRecords": record_problems.items,
    })
}

fn text_record(dir: &Path, id: &str) -> Result<Option<SyncRecord>, String> {
    let key = format!("text:{id}");
    let root = records_root(dir).join(kind_dir("text"));
    let mut path = None;
    for stem in record_file_stems(&key) {
        let yaml = root.join(format!("{stem}.yaml"));
        if yaml.exists() || yaml.with_extension("bak").exists() {
            path = Some(yaml);
            break;
        }
        let json = yaml.with_extension("json");
        if json.exists() || json.with_extension("bak").exists() {
            path = Some(json);
            break;
        }
    }
    let Some(path) = path else {
        return Ok(None);
    };
    let record = match read_record_file(&path) {
        Ok(record) if record.key == key => record,
        Ok(_) => return Ok(None),
        Err(error) => {
            eprintln!("{error}");
            return Ok(None);
        }
    };
    if record.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub(crate) fn text_content(dir: &Path, id: &str) -> Result<Option<String>, String> {
    Ok(text_record(dir, id)?.as_ref().and_then(|record| {
        record
            .data
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    }))
}

pub(crate) fn text_pdf_ocr_pages(dir: &Path, id: &str) -> Result<Option<Value>, String> {
    Ok(text_record(dir, id)?
        .as_ref()
        .and_then(|record| record.data.get("pdfOcrPages").cloned()))
}

pub(crate) fn upsert_text_record(dir: &Path, text: &Value, device_id: &str) -> Result<(), String> {
    let Some(id) = text.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let now = now_millis();
    let key = format!("text:{id}");
    let mut record = live_record(key.clone(), "text", text.clone(), device_id, now);
    // Read only the one existing record for its causal clock instead of
    // scanning the whole records tree (which is seconds on large stores).
    if let Ok(Some(existing)) = read_existing_record(dir, "text", &key) {
        record.causal = existing.causal.clone();
        bump_causal(&mut record.causal, device_id, now);
    }
    write_record(dir, &record)
}

pub(crate) fn delete_text_record(dir: &Path, id: &str, device_id: &str) -> Result<(), String> {
    let now = now_millis();
    let key = format!("text:{id}");
    let base = load_records(dir)
        .ok()
        .and_then(|records| records.get(&key).map(|record| record.causal.clone()));
    write_record(
        dir,
        &tombstone_with_base(&key, device_id, now, base.as_ref()),
    )
}

pub(crate) fn tombstone_all(
    dir: &Path,
    device_id: &str,
) -> Result<BTreeMap<String, SyncRecord>, String> {
    let now = now_millis();
    let records = load_records(dir)?
        .iter()
        .map(|(key, record)| {
            (
                key.clone(),
                tombstone_with_base(key, device_id, now, Some(&record.causal)),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for record in records.values() {
        write_record_with_backup(dir, record, false)?;
    }
    Ok(records)
}

pub(crate) fn remove_record_backups(dir: &Path) -> Result<(), String> {
    remove_backup_files(&records_root(dir))
}

pub(crate) fn write_record(dir: &Path, record: &SyncRecord) -> Result<(), String> {
    write_record_with_backup(dir, record, true)
}

fn write_record_with_backup(
    dir: &Path,
    record: &SyncRecord,
    keep_backup: bool,
) -> Result<(), String> {
    let path = record_path(dir, record);
    let result = write_record_to_path(&path, record, keep_backup);
    if result.is_ok() {
        // On-disk migration: once the record lives under its SHA-256 name,
        // drop the legacy FNV-named file so a store never keeps both.
        remove_legacy_record_file(dir, record)?;
    }
    result
}

fn write_record_to_path(path: &Path, record: &SyncRecord, keep_backup: bool) -> Result<(), String> {
    reject_future_record_at_path(path)?;
    if record.deleted_at.is_some() {
        let value = record_value(record);
        if path.exists()
            && parse_record_file(path)
                .map(|existing| records_equal(&existing, record))
                .unwrap_or(false)
        {
            return write_record_recovery_backup(path);
        }
        atomic_yaml(path, &value, false)?;
        return write_record_recovery_backup(path);
    }
    if path.exists()
        && read_record_file(path)
            .map(|existing| records_equal(&existing, record))
            .unwrap_or(false)
    {
        return Ok(());
    }
    atomic_yaml(path, &record_value(record), keep_backup)
}

fn legacy_record_path(dir: &Path, record: &SyncRecord) -> PathBuf {
    records_root(dir)
        .join(kind_dir(&record.kind))
        .join(format!("{}.yaml", legacy_stable_hash(&record.key)))
}

/// Remove every file written under the legacy FNV-1a name for this record
/// (primary extensions plus the recovery backup). New saves always use the
/// SHA-256 name, so this completes the migration without breaking reads of
/// stores that have not been rewritten yet.
fn remove_legacy_record_file(dir: &Path, record: &SyncRecord) -> Result<(), String> {
    if legacy_stable_hash(&record.key) == stable_hash(&record.key) {
        return Ok(());
    }
    let record_dir = records_root(dir).join(kind_dir(&record.kind));
    for extension in ["yaml", "yml", "json"] {
        let path = record_dir.join(format!("{}.{extension}", legacy_stable_hash(&record.key)));
        durable::remove_file_if_exists(&path)
            .map_err(|e| format!("could not remove legacy record {}: {e}", path.display()))?;
    }
    // `legacy_record_path` already resolves the record directory from the
    // base dir; passing the kind-scoped `record_dir` here would join it a
    // second time and leave the real `<fnv>.bak` orphaned.
    let backup = legacy_record_path(dir, record).with_extension("bak");
    durable::remove_file_if_exists(&backup).map_err(|e| {
        format!(
            "could not remove legacy record backup {}: {e}",
            backup.display()
        )
    })
}

fn write_record_recovery_backup(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("bak");
    let temp = path.with_extension("bak.tmp");
    durable::remove_file_if_exists(&temp)?;
    std::fs::copy(path, &temp).map_err(|e| {
        format!(
            "could not stage record recovery backup {} from {}: {e}",
            temp.display(),
            path.display()
        )
    })?;
    durable::sync_file(&temp)?;
    if let Err(first_error) = std::fs::rename(&temp, &backup) {
        if !backup.exists() {
            return Err(format!(
                "could not install record recovery backup {}: {first_error}",
                backup.display()
            ));
        }
        durable::remove_file_if_exists(&backup)?;
        std::fs::rename(&temp, &backup).map_err(|e| {
            format!(
                "could not replace record recovery backup {} after {first_error}: {e}",
                backup.display()
            )
        })?;
    }
    durable::sync_parent(&backup)
}

pub(crate) fn read_record_file(path: &Path) -> Result<SyncRecord, String> {
    match parse_record_file(path) {
        Ok(record) => Ok(record),
        Err(primary) => {
            let backup = path.with_extension("bak");
            if backup.exists() {
                parse_record_file(&backup).map_err(|backup_error| {
                    format!(
                        "{primary}; backup {} is also unusable: {backup_error}",
                        backup.display()
                    )
                })
            } else {
                Err(primary)
            }
        }
    }
}

pub(crate) fn parse_record_file(path: &Path) -> Result<SyncRecord, String> {
    let raw = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let value: Value = serde_yaml::from_slice(&raw)
        .map_err(|e| format!("record {} is corrupt: {e}", path.display()))?;
    let record =
        parse_record(&value).map_err(|e| format!("record {} is invalid: {e}", path.display()))?;
    let expected_dir = kind_dir(&record.kind);
    let actual_dir = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if actual_dir != expected_dir {
        return Err(format!(
            "record {} is in {actual_dir}, expected {expected_dir}",
            path.display()
        ));
    }
    let expected_name = stable_hash(&record.key);
    let legacy_name = legacy_stable_hash(&record.key);
    let actual_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if actual_name != expected_name && actual_name != legacy_name {
        return Err(format!(
            "record {} has a noncanonical filename",
            path.display()
        ));
    }
    Ok(record)
}

fn atomic_yaml(path: &Path, value: &Value, keep_backup: bool) -> Result<(), String> {
    let bytes = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    durable::write_file_atomic(path, bytes.as_bytes(), keep_backup)
}

fn remove_backup_files(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            remove_backup_files(&path)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("bak") {
            durable::remove_file_if_exists(&path)
                .map_err(|e| format!("could not remove record backup {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

pub(crate) fn record_path(dir: &Path, record: &SyncRecord) -> PathBuf {
    records_root(dir)
        .join(kind_dir(&record.kind))
        .join(format!("{}.yaml", stable_hash(&record.key)))
}

/// Read one record by key without scanning the whole records tree.
/// Mirrors `load_records`'s file preference (yaml > yml > json; a .bak
/// stands in only when no primary exists) and its tolerance of corrupt
/// files (a broken record yields `None`, matching the skip-and-continue
/// behaviour of the full scan).
pub(crate) fn read_existing_record(
    dir: &Path,
    kind: &str,
    key: &str,
) -> Result<Option<SyncRecord>, String> {
    let root = records_root(dir).join(kind_dir(kind));
    for stem in record_file_stems(key) {
        let base = root.join(stem);
        let mut primary: Option<PathBuf> = None;
        for extension in ["yaml", "yml", "json"] {
            let candidate = base.with_extension(extension);
            if candidate.exists() {
                primary = Some(candidate);
                break;
            }
        }
        let path = match primary {
            Some(path) => path,
            None => {
                let backup = base.with_extension("bak");
                if backup.exists() {
                    backup
                } else {
                    continue;
                }
            }
        };
        return match read_record_file(&path) {
            Ok(record) => Ok(Some(record)),
            Err(error) => {
                eprintln!("{error}");
                Ok(None)
            }
        };
    }
    Ok(None)
}

pub(crate) fn kind_dir(kind: &str) -> &str {
    match kind {
        "profile" => "profiles",
        "vocab" => "vocab",
        "text" => "texts",
        "pref" => "prefs",
        "hidden" => "hidden",
        "book" => "books",
        _ => "records",
    }
}

pub(crate) fn parse_record(value: &Value) -> Result<SyncRecord, String> {
    if value.get("format").and_then(Value::as_u64).unwrap_or(0) != FORMAT {
        return Err("unsupported format".to_string());
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "schemaVersion is missing".to_string())?;
    if schema_version != PAYLOAD_SCHEMA_VERSION {
        return Err("unsupported schemaVersion".to_string());
    }
    let key = value
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| "key is missing".to_string())?
        .to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "kind is missing".to_string())?
        .to_string();
    if !RECORD_DIRS.contains(&kind_dir(&kind)) || infer_kind(&key) != kind {
        return Err("key and kind do not match a supported record type".to_string());
    }
    if key
        .split_once(':')
        .map(|(_, suffix)| suffix.trim().is_empty())
        .unwrap_or(true)
    {
        return Err("record key suffix is empty".to_string());
    }
    let updated_at = parse_required_time(value.get("updatedAt"), "updatedAt")?;
    let deleted_at = match value.get("deletedAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_required_time(Some(value), "deletedAt")?),
    };
    let device_id = value
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|device| !device.trim().is_empty())
        .ok_or_else(|| "deviceId is missing".to_string())?
        .to_string();
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let mut causal = parse_causal(value.get("causal"))?;
    if causal.is_empty() {
        causal = legacy_causal_clock(&key, &kind, &data, updated_at, deleted_at, &device_id);
    }
    Ok(SyncRecord {
        key,
        kind,
        data,
        updated_at,
        deleted_at,
        device_id,
        causal,
    })
}

fn reject_future_record_at_path(path: &Path) -> Result<(), String> {
    for candidate in [path.to_path_buf(), path.with_extension("bak")] {
        if !candidate.exists() {
            continue;
        }
        let raw = std::fs::read(&candidate).map_err(|e| {
            format!(
                "could not inspect record before replacing {}: {e}",
                candidate.display()
            )
        })?;
        let Ok(value) = serde_yaml::from_slice::<Value>(&raw) else {
            continue;
        };
        let future_format = value
            .get("format")
            .and_then(Value::as_u64)
            .map(|format| format > FORMAT)
            .unwrap_or(false);
        let future_schema = value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map(|schema| schema > PAYLOAD_SCHEMA_VERSION)
            .unwrap_or(false);
        if future_format || future_schema {
            return Err(format!(
                "refusing to overwrite newer unsupported record {}",
                candidate.display()
            ));
        }
    }
    Ok(())
}

struct ScanProblems {
    total: usize,
    items: Vec<Value>,
}

fn scan_record_problems(dir: &Path, limit: usize) -> ScanProblems {
    let root = records_root(dir);
    let mut problems = ScanProblems {
        total: 0,
        items: Vec::new(),
    };
    if !root.exists() {
        return problems;
    }
    for kind_dir in RECORD_DIRS {
        let dir = root.join(kind_dir);
        if !dir.exists() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.contains(".sync-conflict-"))
            {
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str());
            let record_path = match extension {
                Some("yaml" | "yml" | "json") => path,
                Some("bak") => {
                    let yaml = path.with_extension("yaml");
                    let primary = if yaml.exists() {
                        yaml
                    } else {
                        path.with_extension("json")
                    };
                    if primary.exists() {
                        continue;
                    }
                    path
                }
                _ => continue,
            };
            if let Err(error) = read_record_file(&record_path) {
                problems.total += 1;
                if problems.items.len() < limit {
                    problems.items.push(json!({
                        "path": display_relative(&dir, &record_path),
                        "kind": kind_dir.trim_end_matches('s'),
                        "error": error,
                    }));
                }
            }
        }
    }
    problems
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

pub(crate) fn record_value(record: &SyncRecord) -> Value {
    json!({
        "format": FORMAT,
        "schemaVersion": PAYLOAD_SCHEMA_VERSION,
        "key": record.key,
        "kind": record.kind,
        "updatedAt": record.updated_at.to_string(),
        "deletedAt": record.deleted_at.map(|value| value.to_string()),
        "deviceId": record.device_id,
        "causal": record.causal,
        "data": record.data,
    })
}

fn records_equal(left: &SyncRecord, right: &SyncRecord) -> bool {
    left.key == right.key
        && left.kind == right.kind
        && left.data == right.data
        && left.updated_at == right.updated_at
        && left.deleted_at == right.deleted_at
        && left.device_id == right.device_id
        && left.causal == right.causal
}

pub(crate) fn stable_hash(value: &str) -> String {
    // Full 64-hex SHA-256 digest (no prefix truncation): filename
    // collisions are cryptographically negligible, unlike the 64-bit
    // FNV-1a scheme below which older builds wrote to disk.
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            use std::fmt::Write;
            let _ = write!(output, "{byte:02x}");
            output
        })
}

/// FNV-1a 64-bit filename scheme written by builds before the SHA-256
/// migration. Kept so legacy files keep working (dual-read) and get
/// rewritten under their SHA-256 name on the next save.
fn legacy_stable_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Every filename stem that may identify a record on disk, newest first.
fn record_file_stems(key: &str) -> [String; 2] {
    [stable_hash(key), legacy_stable_hash(key)]
}

fn parse_required_time(value: Option<&Value>, field: &str) -> Result<u128, String> {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u128>().ok())
        .or_else(|| value.and_then(Value::as_u64).map(u128::from))
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{field} is invalid"))
}
