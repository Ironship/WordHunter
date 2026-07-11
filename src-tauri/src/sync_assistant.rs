use serde_json::{Value, json};
use std::path::Path;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

use crate::store::record_files;

#[cfg(not(target_os = "android"))]
const MANAGED_SYNC_FOLDER: &str = "WordHunterSync";

#[cfg(not(target_os = "android"))]
pub(crate) fn managed_sync_dir() -> Result<PathBuf, String> {
    if let Some(home) = crate::paths::home_dir() {
        return Ok(home.join("Documents").join(MANAGED_SYNC_FOLDER));
    }
    Err("could not locate the user home folder".to_string())
}

pub(crate) fn configured_sync_health() -> Value {
    match crate::paths::sync_dir(crate::APP_NAME) {
        Ok(Some(dir)) => folder_health(&dir),
        Ok(None) => json!({
            "status": "not-configured",
            "ok": false,
            "recordCount": 0,
            "issueCount": 0,
        }),
        Err(error) => json!({
            "status": "missing",
            "ok": false,
            "recordCount": 0,
            "issueCount": 1,
            "error": error,
        }),
    }
}

pub(crate) fn folder_health(dir: &Path) -> Value {
    if !dir.exists() {
        return json!({
            "status": "missing",
            "ok": false,
            "path": dir.to_string_lossy(),
            "recordCount": 0,
            "issueCount": 1,
        });
    }
    if !dir.is_dir() {
        return json!({
            "status": "not-a-folder",
            "ok": false,
            "path": dir.to_string_lossy(),
            "recordCount": 0,
            "issueCount": 1,
        });
    }

    let writable = probe_writable(dir);
    let recovery = record_files::recovery_status(dir);
    let skipped = recovery
        .get("skippedRecordCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let corrupt_conflicts = recovery
        .get("corruptConflictCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let issue_count = skipped + corrupt_conflicts + u64::from(!writable);
    let record_count = record_files::load_records(dir)
        .map(|records| records.len())
        .unwrap_or(0);
    let mount = mount_info_for_path(dir);
    let cloud_like = mount
        .as_ref()
        .and_then(|value| value.get("cloudLike"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = if !writable {
        "read-only"
    } else if issue_count > 0 {
        "needs-attention"
    } else if cloud_like {
        "caution"
    } else {
        "ready"
    };

    json!({
        "status": status,
        "ok": writable && issue_count == 0,
        "path": dir.to_string_lossy(),
        "recordCount": record_count,
        "issueCount": issue_count,
        "recovery": recovery,
        "mount": mount,
    })
}

fn probe_writable(dir: &Path) -> bool {
    let path = dir.join(format!(".wordhunter-health-{}.tmp", std::process::id()));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        file.write_all(b"ok").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(path);
    result.is_ok()
}

#[cfg(target_os = "linux")]
fn mount_info_for_path(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    parse_linux_mountinfo_for_path(&raw, path)
}

#[cfg(not(target_os = "linux"))]
fn mount_info_for_path(_path: &Path) -> Option<Value> {
    None
}

#[cfg(target_os = "linux")]
fn parse_linux_mountinfo_for_path(raw: &str, path: &Path) -> Option<Value> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut best: Option<(usize, Value)> = None;
    for line in raw.lines() {
        let mut parts = line.split(" - ");
        let left = parts.next()?;
        let right = parts.next().unwrap_or_default();
        let left_fields = left.split_whitespace().collect::<Vec<_>>();
        let right_fields = right.split_whitespace().collect::<Vec<_>>();
        if left_fields.len() < 5 || right_fields.is_empty() {
            continue;
        }
        let mount_point = PathBuf::from(unescape_mountinfo_field(left_fields[4]));
        if !path.starts_with(&mount_point) {
            continue;
        }
        let fs_type = right_fields[0].to_string();
        let source = right_fields.get(1).copied().unwrap_or_default().to_string();
        let haystack = format!(
            "{} {} {}",
            fs_type.to_lowercase(),
            source.to_lowercase(),
            mount_point.to_string_lossy().to_lowercase()
        );
        let cloud_like = haystack.contains("fuse")
            || haystack.contains("rclone")
            || haystack.contains("gvfs")
            || haystack.contains("google-drive");
        let len = mount_point.as_os_str().len();
        let value = json!({
            "mountPoint": mount_point.to_string_lossy(),
            "filesystem": fs_type,
            "source": source,
            "cloudLike": cloud_like,
        });
        if best.as_ref().is_none_or(|(best_len, _)| len > *best_len) {
            best = Some((len, value));
        }
    }
    best.map(|(_, value)| value)
}

#[cfg(target_os = "linux")]
fn unescape_mountinfo_field(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_reports_corrupt_record_files_without_deleting_them() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("records/v1/prefs/bad.json");
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(&record, "{").unwrap();

        let health = folder_health(dir.path());

        assert_eq!(health["status"], "needs-attention");
        assert_eq!(health["ok"], false);
        assert_eq!(health["issueCount"], 1);
        assert!(record.is_file());
    }

    #[test]
    fn health_reports_ready_folder_with_records() {
        let dir = tempfile::tempdir().unwrap();
        let payload = json!({
            "texts": [],
            "prefs": { "learningLanguage": "de" },
            "hiddenBooks": [],
            "vocab": {
                "de": {
                    "preferences": {},
                    "userBooks": [],
                    "hiddenBuiltInBooks": [],
                    "archivedBookIds": [],
                    "vocab": {
                        "haus": { "word": "haus", "translation": "house", "status": "learning" }
                    }
                }
            }
        });
        let records = record_files::payload_to_records(&payload, "device-a", 1);
        record_files::write_records(dir.path(), &records).unwrap();

        let health = folder_health(dir.path());

        assert_eq!(health["status"], "ready");
        assert_eq!(health["ok"], true);
        assert!(health["recordCount"].as_u64().unwrap() > 0);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parses_linux_cloud_like_mountinfo_for_path() {
        let raw = "36 25 0:31 / / rw,relatime - ext4 /dev/root rw\n\
                   42 36 0:44 / /home/user/GoogleDrive rw,nosuid,nodev - fuse.rclone gdrive: rw";

        let mount =
            parse_linux_mountinfo_for_path(raw, Path::new("/home/user/GoogleDrive/WordHunterSync"))
                .unwrap();

        assert_eq!(mount["filesystem"], "fuse.rclone");
        assert_eq!(mount["cloudLike"], true);
    }
}
