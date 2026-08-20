use std::path::Path;

/// Create (or truncate) a file for writing without ever following a symlink
/// at `path` itself.
///
/// On Unix this uses `O_NOFOLLOW`: a symlink planted at `path` between a
/// caller's `safe_join`/`symlink_metadata` check and this open makes the open
/// fail with `ELOOP` instead of redirecting the write. Plain `File::create`
/// would happily write through the symlink (F14 TOCTOU gap). Non-Unix targets
/// keep the plain create — Windows symlinks require elevation/dev-mode, and
/// `O_NOFOLLOW` does not exist there.
///
/// Note `O_NOFOLLOW` guards only the final path component. A symlink swapped
/// in for a *parent directory* still redirects the write; callers own and
/// create the parent dirs under the app-data root, and an attacker able to
/// write into those already owns the user's data, so this residual window is
/// accepted and documented rather than chased with hashed-path schemes.
#[cfg(unix)]
fn create_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn create_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::create(path)
}

pub(crate) fn recover_replace(path: &Path) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    if path.exists() {
        if tmp.exists() {
            let _ = std::fs::remove_file(&tmp);
        }
        return Ok(());
    }
    if tmp.exists() {
        std::fs::rename(&tmp, path)
            .map_err(|e| format!("could not complete replace {}: {e}", path.display()))?;
        sync_parent(path)?;
        return Ok(());
    }
    if backup.exists() {
        std::fs::copy(&backup, path)
            .map_err(|e| format!("could not restore backup {}: {e}", path.display()))?;
        sync_file(path)?;
        sync_parent(path)?;
    }
    Ok(())
}

pub(crate) fn write_file_atomic(
    path: &Path,
    bytes: &[u8],
    keep_backup: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    if tmp.exists() {
        std::fs::remove_file(&tmp)
            .map_err(|e| format!("could not remove stale temp {}: {e}", tmp.display()))?;
    }
    {
        use std::io::Write;
        let mut file = create_no_follow(&tmp)
            .map_err(|e| format!("could not create temp {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("could not write temp {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("could not sync temp {}: {e}", tmp.display()))?;
    }

    if keep_backup && path.exists() {
        copy_file_synced(path, &backup)?;
    }

    match std::fs::rename(&tmp, path) {
        Ok(()) => {
            sync_parent(path)?;
            Ok(())
        }
        Err(first_error) if path.exists() => {
            replace_existing_with_backup(path, &tmp, &backup, keep_backup, first_error)
        }
        Err(error) => Err(format!("could not replace {}: {error}", path.display())),
    }
}

pub(crate) fn write_json_atomic(
    path: &Path,
    value: &serde_json::Value,
    pretty: bool,
    keep_backup: bool,
) -> Result<(), String> {
    let bytes = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    }
    .map_err(|e| e.to_string())?;
    write_file_atomic(path, &bytes, keep_backup)
}

pub(crate) fn copy_file_atomic(
    source: &Path,
    target: &Path,
    keep_backup: bool,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("tmp");
    let backup = target.with_extension("bak");
    if tmp.exists() {
        std::fs::remove_file(&tmp)
            .map_err(|e| format!("could not remove stale temp {}: {e}", tmp.display()))?;
    }
    {
        let mut input = std::fs::File::open(source)
            .map_err(|e| format!("could not read source {}: {e}", source.display()))?;
        let mut output = create_no_follow(&tmp)
            .map_err(|e| format!("could not create temp {}: {e}", tmp.display()))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|e| format!("could not copy source {}: {e}", source.display()))?;
        output
            .sync_all()
            .map_err(|e| format!("could not sync temp {}: {e}", tmp.display()))?;
    }
    if keep_backup && target.exists() {
        copy_file_synced(target, &backup)?;
    }
    match std::fs::rename(&tmp, target) {
        Ok(()) => {
            sync_parent(target)?;
            Ok(())
        }
        Err(first_error) if target.exists() => {
            replace_existing_with_backup(target, &tmp, &backup, keep_backup, first_error)
        }
        Err(error) => Err(format!("could not replace {}: {error}", target.display())),
    }
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => {
            sync_parent(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

pub(crate) fn sync_file(path: &Path) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("could not open {} for sync: {e}", path.display()))?;
    file.sync_all()
        .map_err(|e| format!("could not sync {}: {e}", path.display()))
}

#[cfg(unix)]
pub(crate) fn sync_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let file = std::fs::File::open(parent)
        .map_err(|e| format!("could not open parent {} for sync: {e}", parent.display()))?;
    file.sync_all()
        .map_err(|e| format!("could not sync parent {}: {e}", parent.display()))
}

#[cfg(not(unix))]
pub(crate) fn sync_parent(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn replace_existing_with_backup(
    path: &Path,
    tmp: &Path,
    backup: &Path,
    keep_backup: bool,
    first_error: std::io::Error,
) -> Result<(), String> {
    if !keep_backup {
        let _ = std::fs::remove_file(backup);
        std::fs::rename(path, backup).map_err(|e| {
            format!(
                "could not move {} to backup after replace failed ({first_error}): {e}",
                path.display()
            )
        })?;
        sync_parent(path)?;
    } else {
        std::fs::remove_file(path).map_err(|e| {
            format!(
                "could not remove {} after replace failed ({first_error}): {e}",
                path.display()
            )
        })?;
        sync_parent(path)?;
    }

    match std::fs::rename(tmp, path) {
        Ok(()) => {
            sync_parent(path)?;
            if !keep_backup {
                let _ = std::fs::remove_file(backup);
                sync_parent(path)?;
            }
            Ok(())
        }
        Err(error) => {
            if backup.exists() && !path.exists() {
                let _ = std::fs::copy(backup, path);
                let _ = sync_file(path);
                let _ = sync_parent(path);
            }
            Err(format!("could not replace {}: {error}", path.display()))
        }
    }
}

fn copy_file_synced(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::copy(source, target).map_err(|e| {
        format!(
            "could not write backup {} from {}: {e}",
            target.display(),
            source.display()
        )
    })?;
    sync_file(target)?;
    sync_parent(target)
}

#[cfg(all(unix, test))]
mod no_follow_tests {
    use super::*;

    #[test]
    fn create_no_follow_refuses_symlinked_final_component() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real.txt");
        std::fs::write(&real, b"real target content").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let error =
            create_no_follow(&link).expect_err("open with O_NOFOLLOW must refuse a symlink");
        assert_eq!(error.raw_os_error(), Some(libc::ELOOP), "{error}");
        // The write must not have been redirected through the symlink.
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "real target content"
        );
    }
}
