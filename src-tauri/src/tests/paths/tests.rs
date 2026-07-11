use super::{data_dir, device_id, read_app_config, sanitize_id, set_sync_dir, sync_dir};
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
    assert!(sanitize_id("../book-1").is_err());
    assert!(sanitize_id("folder\\book-1").is_err());
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
fn config_write_keeps_backup_of_previous_value() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    set_sync_dir("WordHunter", first.path()).unwrap();
    set_sync_dir("WordHunter", second.path()).unwrap();

    assert_eq!(
        std::fs::read_to_string(xdg_config.path().join("WordHunter-sync-dir.txt")).unwrap(),
        second.path().to_string_lossy()
    );
    assert_eq!(
        std::fs::read_to_string(xdg_config.path().join("WordHunter-sync-dir.bak")).unwrap(),
        first.path().to_string_lossy()
    );
}

#[test]
fn config_read_recovers_missing_primary_from_backup() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let sync = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());
    let primary = xdg_config.path().join("WordHunter-sync-dir.txt");
    let backup = xdg_config.path().join("WordHunter-sync-dir.bak");
    std::fs::write(&backup, sync.path().to_string_lossy().as_bytes()).unwrap();

    assert_eq!(
        sync_dir("WordHunter").unwrap(),
        Some(sync.path().to_path_buf())
    );
    assert_eq!(
        std::fs::read_to_string(primary).unwrap(),
        sync.path().to_string_lossy()
    );
    assert!(backup.is_file());
}

#[test]
fn config_read_completes_interrupted_temp_replace_when_primary_is_missing() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());
    let primary = xdg_config.path().join("WordHunter-device-id.txt");
    let temp = xdg_config.path().join("WordHunter-device-id.tmp");
    std::fs::write(&temp, b"device-from-temp").unwrap();

    assert_eq!(
        read_app_config("WordHunter", "device-id")
            .unwrap()
            .as_deref(),
        Some("device-from-temp")
    );
    assert!(primary.is_file());
    assert!(!temp.exists());
}

#[test]
fn defaults_data_dir_to_xdg_data_home() {
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
fn defaults_data_dir_to_xdg_data_home_even_when_config_dir_has_app_folder() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let config_app_folder = home.path().join(".config/WordHunter");
    std::fs::create_dir_all(&config_app_folder).unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let dir = data_dir("WordHunter").unwrap();

    assert_eq!(dir, xdg_data.path().join("WordHunter"));
    assert!(dir.is_dir());
    assert_ne!(dir, config_app_folder);
}

#[test]
fn ignores_home_config_redirect_when_xdg_config_home_is_explicit() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let sync = tempfile::tempdir().unwrap();
    let home_config = home.path().join(".config");
    std::fs::create_dir_all(&home_config).unwrap();
    std::fs::write(
        home_config.join("WordHunter-sync-dir.txt"),
        sync.path().to_string_lossy().as_bytes(),
    )
    .unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    assert_eq!(sync_dir("WordHunter").unwrap(), None);
}

#[test]
fn config_reads_fallback_to_home_config_when_xdg_config_home_is_unset() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let sync = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".config")).unwrap();
    std::fs::write(
        home.path().join(".config/WordHunter-sync-dir.txt"),
        sync.path().to_string_lossy().as_bytes(),
    )
    .unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::unset("XDG_CONFIG_HOME");
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    assert_eq!(
        sync_dir("WordHunter").unwrap(),
        Some(sync.path().to_path_buf())
    );
}

#[test]
fn config_reads_fail_without_appdata_xdg_config_home_or_home() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::unset("HOME");
    let _xdg_config = EnvGuard::unset("XDG_CONFIG_HOME");
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let error = sync_dir("WordHunter").unwrap_err();

    assert!(error.contains("could not locate user config directory"));
}

#[test]
fn data_dir_fallbacks_to_home_local_share_when_xdg_data_home_is_unset() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::unset("XDG_DATA_HOME");

    let dir = data_dir("WordHunter").unwrap();

    assert_eq!(dir, home.path().join(".local/share/WordHunter"));
    assert!(dir.is_dir());
}

#[test]
fn data_dir_fails_without_appdata_xdg_data_home_or_home() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::unset("HOME");
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::unset("XDG_DATA_HOME");

    let error = data_dir("WordHunter").unwrap_err();

    assert!(error.contains("could not locate user data directory"));
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
