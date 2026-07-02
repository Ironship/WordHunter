use super::{data_dir, device_id, sanitize_id, set_sync_dir, sync_dir};
use std::ffi::OsString;

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &std::path::Path) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: tests hold TEST_ENV_LOCK while overriding process env.
        unsafe { std::env::set_var(key, value) };
        Self { key, previous }
    }

    fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: tests hold TEST_ENV_LOCK while overriding process env.
        unsafe { std::env::remove_var(key) };
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            // SAFETY: tests hold TEST_ENV_LOCK while restoring process env.
            unsafe { std::env::set_var(self.key, previous) };
        } else {
            // SAFETY: tests hold TEST_ENV_LOCK while restoring process env.
            unsafe { std::env::remove_var(self.key) };
        }
    }
}

#[test]
fn sanitizes_ids_to_file_names() {
    assert_eq!(sanitize_id("book-1").unwrap(), "book-1");
    assert_eq!(sanitize_id("../book-1").unwrap(), "book-1");
    assert!(sanitize_id("..").is_err());
}

#[test]
fn stores_sync_redirect_in_xdg_config_home() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let sync = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    set_sync_dir("WordHunter", sync.path()).unwrap();

    let redirect = xdg_config.path().join("WordHunter-sync-dir.txt");
    assert_eq!(
        std::fs::read_to_string(redirect).unwrap(),
        sync.path().to_string_lossy()
    );
    assert!(!home.path().join(".config/WordHunter-sync-dir.txt").exists());
    assert_eq!(
        sync_dir("WordHunter").unwrap(),
        Some(sync.path().to_path_buf())
    );
}

#[test]
fn defaults_data_dir_to_xdg_data_home_when_no_legacy_dir_exists() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let dir = data_dir("WordHunter").unwrap();

    assert_eq!(dir, xdg_data.path().join("WordHunter"));
    assert!(dir.is_dir());
}

#[test]
fn keeps_existing_legacy_config_data_dir() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let legacy = home.path().join(".config/WordHunter");
    std::fs::create_dir_all(&legacy).unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let dir = data_dir("WordHunter").unwrap();

    assert_eq!(dir, legacy);
    assert!(!xdg_data.path().join("WordHunter").exists());
}

#[test]
fn reads_legacy_sync_redirect_when_xdg_config_redirect_is_missing() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let sync = tempfile::tempdir().unwrap();
    let legacy_config = home.path().join(".config");
    std::fs::create_dir_all(&legacy_config).unwrap();
    std::fs::write(
        legacy_config.join("WordHunter-sync-dir.txt"),
        sync.path().to_string_lossy().as_bytes(),
    )
    .unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    assert_eq!(
        sync_dir("WordHunter").unwrap(),
        Some(sync.path().to_path_buf())
    );
}

#[test]
fn writes_device_id_to_xdg_config_home() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let id = device_id("WordHunter").unwrap();

    assert!(!id.trim().is_empty());
    assert_eq!(
        std::fs::read_to_string(xdg_config.path().join("WordHunter-device-id.txt")).unwrap(),
        id
    );
    assert!(
        !home
            .path()
            .join(".config/WordHunter-device-id.txt")
            .exists()
    );
}
