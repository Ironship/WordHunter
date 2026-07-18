#[cfg(not(target_os = "android"))]
mod web_app;

use std::path::Path;

#[cfg(target_os = "android")]
mod android;

type SetupResult = Result<(), Box<dyn std::error::Error>>;

#[cfg(target_os = "android")]
pub(crate) use android::setup;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(crate) use web_app::setup_desktop as setup;

#[cfg(not(target_os = "android"))]
pub(crate) fn open_path(path: impl AsRef<Path>) {
    let _ = open::that(path.as_ref());
}

#[cfg(target_os = "android")]
pub(crate) fn open_path(_path: impl AsRef<Path>) {}
