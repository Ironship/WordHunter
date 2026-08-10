//! Shared helpers for reaching host-installed tools from sandboxes.
//!
//! Flatpak exposes the host filesystem read-only under `/run/host` (the
//! `--filesystem=host-os:ro` finish-arg) and snapd bind-mounts the host
//! root at `/var/lib/snapd/hostfs`. Host binaries that are python scripts
//! (`/usr/bin/yt-dlp`, `/usr/bin/ebook-convert`) cannot run through the
//! sandbox interpreter: their shebang and hardcoded module paths resolve
//! inside the sandbox. The callers here build the environment that lets
//! the *host* interpreter run them with the host's libraries and
//! dist-packages.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Subdirectories under a host prefix that hold the host's dynamic
/// libraries (mirrors the paths the OCR runner's pdftoppm fallback uses).
const HOST_LIB_SUBDIRS: &[&str] = &[
    "lib64",
    "usr/lib64",
    "lib",
    "usr/lib",
    "lib/x86_64-linux-gnu",
    "usr/lib/x86_64-linux-gnu",
];

/// An `LD_LIBRARY_PATH` value that lets a host binary (for example the
/// host Python interpreter) load its shared libraries when spawned from a
/// sandbox, preserving any value already set in the sandbox.
pub(crate) fn host_library_path_for(prefix: &Path) -> String {
    let mut paths = HOST_LIB_SUBDIRS
        .iter()
        .map(|suffix| prefix.join(suffix).to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if let Ok(existing) = std::env::var("LD_LIBRARY_PATH")
        && !existing.trim().is_empty()
    {
        paths.push(existing);
    }
    paths.join(":")
}

/// Prepends `host_path` to the environment variable `name`, preserving any
/// value already set in the sandbox.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn prepend_path_var(name: &str, host_path: PathBuf) -> OsString {
    let mut value = host_path.into_os_string();
    if let Some(existing) = std::env::var_os(name)
        && !existing.is_empty()
    {
        value.push(":");
        value.push(existing);
    }
    value
}
