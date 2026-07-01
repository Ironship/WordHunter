mod ebook;
mod external_translator;
mod handlers;
#[cfg(target_os = "android")]
#[path = "platform/android_backend/offline_translator.rs"]
mod offline_translator;
#[cfg(not(target_os = "android"))]
mod offline_translator;
mod paths;
#[cfg(target_os = "android")]
#[path = "platform/android_backend/pdf_ocr.rs"]
mod pdf_ocr;
#[cfg(not(target_os = "android"))]
mod pdf_ocr;
mod platform;
#[cfg(target_os = "android")]
#[path = "platform/android_backend/popup.rs"]
mod popup;
#[cfg(not(target_os = "android"))]
mod popup;
mod proxy;
mod response;
mod router;
mod server;
mod srs;
mod store;
mod subtitles;
mod tokenizer;
#[cfg(target_os = "android")]
#[path = "platform/android_backend/tts.rs"]
mod tts;
#[cfg(not(target_os = "android"))]
mod tts;
mod update;
mod vocab_export;
mod vocab_index;
mod youglish;
mod youtube_captions;

const APP_NAME: &str = "WordHunter";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const HOST: &str = "127.0.0.1";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("--ct2-translate") {
        std::process::exit(offline_translator::run_worker());
    }

    tauri::Builder::default()
        .setup(platform::setup)
        .run(tauri::generate_context!())
        .expect("failed to run Word Hunter");
}
