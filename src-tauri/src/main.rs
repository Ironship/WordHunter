#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ebook;
mod external_translator;
mod offline_translator;
mod paths;
mod pdf_ocr;
mod popup;
mod proxy;
mod response;
mod router;
mod server;
mod srs;
mod store;
mod subtitles;
mod tokenizer;
mod tts;
mod update;
mod vocab_export;
mod vocab_index;
mod youglish;

use std::sync::Arc;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

use store::Store;

const APP_NAME: &str = "WordHunter";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const HOST: &str = "127.0.0.1";

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--ct2-translate") {
        std::process::exit(offline_translator::run_worker());
    }

    tauri::Builder::default()
        .setup(|app| {
            let store = Arc::new(Store::new(APP_NAME)?);
            let token = server::make_token();
            let app_handle = app.handle().clone();
            let port = server::start_server(store, token, app_handle)?;
            let url = format!("http://{HOST}:{port}/index.html");

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(Url::parse(&url).map_err(|e| e.to_string())?),
            )
            .title("Word Hunter")
            .inner_size(1360.0, 880.0)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Word Hunter");
}
