use std::path::Path;

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
        let mut file = std::fs::File::create(&tmp)
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
        let mut output = std::fs::File::create(&tmp)
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
