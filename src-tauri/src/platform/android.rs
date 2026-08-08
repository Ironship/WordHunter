use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{APP_NAME, server, store::Store};

use super::SetupResult;

const ANDROID_SERVER_PORT: u16 = 38619;

pub(crate) fn setup(app: &mut tauri::App) -> SetupResult {
    eprintln!("WordHunter Android setup: starting backend on 127.0.0.1:{ANDROID_SERVER_PORT}");
    // SAFETY: Android setup runs before WordHunter starts backend worker threads.
    unsafe { std::env::set_var("APPDATA", app.path().app_data_dir()?) };
    let store = std::sync::Arc::new(Store::new(APP_NAME).map_err(boxed_string)?);
    let recovery_store = std::sync::Arc::clone(&store);
    std::thread::spawn(move || {
        if let Err(error) = recovery_store.recover_android_startup_guarded() {
            eprintln!("WordHunter Android startup recovery failed: {error}");
        }
    });
    let token = server::make_token();
    let app_handle = app.handle().clone();
    // The fixed port can be taken (stale process, second instance); fall
    // back to the next ports instead of failing the whole app.
    let mut port = ANDROID_SERVER_PORT;
    let actual_port = loop {
        match server::start_server_on_port(store.clone(), token.clone(), app_handle.clone(), port) {
            Ok(bound) => break bound,
            Err(error) if port < ANDROID_SERVER_PORT + 10 => {
                eprintln!("WordHunter Android setup: port {port} unavailable ({error}), trying next");
                port += 1;
            }
            Err(error) => return Err(boxed_string(error)),
        }
    };
    eprintln!("WordHunter Android setup: backend ready on 127.0.0.1:{actual_port}");
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .ok_or_else(|| boxed_string("Android window config is missing".to_string()))?;
    // The config URL embeds the default port; point the webview at the
    // port that was actually bound.
    WebviewWindowBuilder::from_config(app.handle(), window_config)?
        .url(WebviewUrl::External(
            url::Url::parse(&format!("http://127.0.0.1:{actual_port}/index.html"))
                .map_err(boxed_string)?,
        ))
        .build()?;
    Ok(())
}

fn boxed_string(err: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))
}
