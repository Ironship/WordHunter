use tauri::{Manager, WebviewWindowBuilder};

use std::sync::Arc;

use crate::{APP_NAME, server, store::Store};

use super::SetupResult;

const ANDROID_SERVER_PORT: u16 = 38619;

pub(crate) fn setup(app: &mut tauri::App) -> SetupResult {
    eprintln!("WordHunter Android setup: starting backend on 127.0.0.1:{ANDROID_SERVER_PORT}");
    // SAFETY: Android setup runs before WordHunter starts backend worker threads.
    unsafe { std::env::set_var("APPDATA", app.path().app_data_dir()?) };
    let store = Arc::new(Store::new(APP_NAME).map_err(boxed_string)?);
    let recovery_store = Arc::clone(&store);
    std::thread::spawn(move || {
        if let Err(error) = recovery_store.recover_pending_save_guarded() {
            eprintln!("WordHunter Android pending save recovery failed: {error}");
        }
        if let Err(error) = recovery_store.discard_abandoned_book_imports() {
            eprintln!("WordHunter Android PDF import recovery failed: {error}");
        }
    });
    let token = server::make_token();
    let app_handle = app.handle().clone();
    server::start_server_on_port(store, token, app_handle, ANDROID_SERVER_PORT)
        .map_err(boxed_string)?;
    eprintln!("WordHunter Android setup: backend ready on 127.0.0.1:{ANDROID_SERVER_PORT}");
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| boxed_string("Android window config is missing".to_string()))?;
    WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;
    Ok(())
}

fn boxed_string(err: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))
}
