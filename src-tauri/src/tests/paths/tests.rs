#[cfg(unix)]
use super::config_dir;
use super::{data_dir, device_id, read_config_file, sanitize_id, write_config_file};
use std::ffi::OsString;
use std::path::Path;

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
    assert!(sanitize_id("book:alternate-stream").is_err());
    assert!(sanitize_id("..").is_err());
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

    write_config_file(
        "WordHunter",
        "device-id",
        first.path().to_string_lossy().as_bytes(),
    )
    .unwrap();
    write_config_file(
        "WordHunter",
        "device-id",
        second.path().to_string_lossy().as_bytes(),
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(xdg_config.path().join("WordHunter-device-id.txt")).unwrap(),
        second.path().to_string_lossy()
    );
    assert_eq!(
        std::fs::read_to_string(xdg_config.path().join("WordHunter-device-id.bak")).unwrap(),
        first.path().to_string_lossy()
    );
}

#[test]
fn config_read_recovers_missing_primary_from_backup() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());
    let primary = xdg_config.path().join("WordHunter-device-id.txt");
    let backup = xdg_config.path().join("WordHunter-device-id.bak");
    std::fs::write(&backup, b"restored-device").unwrap();

    assert_eq!(
        read_config_file("WordHunter", "device-id")
            .unwrap()
            .as_deref(),
        Some("restored-device")
    );
    assert_eq!(std::fs::read_to_string(primary).unwrap(), "restored-device");
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
        read_config_file("WordHunter", "device-id")
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
fn ignores_home_config_when_xdg_config_home_is_explicit() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let home_config = home.path().join(".config");
    std::fs::create_dir_all(&home_config).unwrap();
    std::fs::write(home_config.join("WordHunter-device-id.txt"), b"home-device").unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    assert_eq!(read_config_file("WordHunter", "device-id").unwrap(), None);
}

#[test]
fn config_reads_fallback_to_home_config_when_xdg_config_home_is_unset() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".config")).unwrap();
    std::fs::write(
        home.path().join(".config/WordHunter-device-id.txt"),
        b"home-device",
    )
    .unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::unset("XDG_CONFIG_HOME");
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    assert_eq!(
        read_config_file("WordHunter", "device-id")
            .unwrap()
            .as_deref(),
        Some("home-device")
    );
}

#[cfg(unix)]
#[test]
fn config_resolves_real_home_when_home_is_unset() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::unset("HOME");
    let _xdg_config = EnvGuard::unset("XDG_CONFIG_HOME");

    // $HOME is gone, so the passwd entry (getpwuid) must supply the home
    // directory (issue #135, bullet 2).
    #[allow(deprecated)]
    let expected = std::env::home_dir().expect("getpwuid must resolve a home");
    assert_eq!(config_dir().unwrap(), expected.join(".config"));
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

#[cfg(unix)]
#[test]
fn data_dir_resolves_real_home_local_share_when_home_is_unset() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::unset("APPDATA");
    let _home = EnvGuard::unset("HOME");
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::unset("XDG_DATA_HOME");

    let dir = data_dir("WordHunter").unwrap();

    // $HOME is gone, so the passwd entry (getpwuid) must supply the home
    // directory (issue #135, bullet 2).
    #[allow(deprecated)]
    let expected = std::env::home_dir().expect("getpwuid must resolve a home");
    assert_eq!(dir, expected.join(".local/share/WordHunter"));
    assert!(dir.is_dir());
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

#[cfg(unix)]
#[test]
fn data_dir_ignores_appdata_on_unix_and_uses_xdg_data_home() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();
    let home = tempfile::tempdir().unwrap();
    let appdata = tempfile::tempdir().unwrap();
    let xdg_config = tempfile::tempdir().unwrap();
    let xdg_data = tempfile::tempdir().unwrap();
    let _appdata = EnvGuard::set("APPDATA", appdata.path());
    let _home = EnvGuard::set("HOME", home.path());
    let _xdg_config = EnvGuard::set("XDG_CONFIG_HOME", xdg_config.path());
    let _xdg_data = EnvGuard::set("XDG_DATA_HOME", xdg_data.path());

    let dir = data_dir("WordHunter").unwrap();

    // APPDATA is a Wine/Proton artifact on Linux and must not win over the
    // XDG base directories (issue #135, bullet 1).
    assert_eq!(dir, xdg_data.path().join("WordHunter"));
    assert!(dir.is_dir());
    assert_ne!(dir, appdata.path().join("WordHunter"));
}

#[test]
fn data_dir_pointer_permission_denied_is_not_cleared() {
    let _lock = crate::TEST_ENV_LOCK.lock().unwrap();

    // A stored pointer that exists but is unreadable under confinement
    // (flatpak/snap without filesystem access) must not be treated like a
    // missing directory and must not be silently cleared (issue #135,
    // bullet 5).
    let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    let error = super::classify_data_pointer(Path::new("/x"), Err(denied)).unwrap_err();
    assert!(error.contains("permission denied"));
    assert!(error.contains("flatpak override"));
    assert!(error.contains("snap connect"));

    // NotFound keeps the historical behavior: the pointer is cleared and the
    // app falls back to the default data folder.
    let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert!(matches!(
        super::classify_data_pointer(Path::new("/x"), Err(missing)).unwrap(),
        super::DataDirPointer::Clear
    ));

    // A real directory keeps being used; a real missing path is cleared.
    let existing = tempfile::tempdir().unwrap();
    assert!(matches!(
        super::classify_data_pointer(existing.path(), std::fs::metadata(existing.path())).unwrap(),
        super::DataDirPointer::Use
    ));
    let gone = existing.path().join("gone");
    assert!(matches!(
        super::classify_data_pointer(&gone, std::fs::metadata(&gone)).unwrap(),
        super::DataDirPointer::Clear
    ));
}
