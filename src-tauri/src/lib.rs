mod ai_explainer;
mod ebook;
mod external_translator;
mod handlers;
mod http;
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
mod pdf_text_layer;
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
mod template;
mod tokenizer;
#[cfg(target_os = "android")]
#[path = "platform/android_backend/tts.rs"]
mod tts;
#[cfg(not(target_os = "android"))]
mod tts;
mod update;
mod vocab_export;
mod vocab_index;
mod youtube_captions;

const APP_NAME: &str = "WordHunter";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const HOST: &str = "127.0.0.1";

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn app_or_log_error<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(app) => Some(app),
        Err(error) => {
            eprintln!("failed to build Word Hunter: {error}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("--ct2-translate") {
        std::process::exit(offline_translator::run_worker());
    }

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        use tauri::Manager as _;
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    let Some(app) = app_or_log_error(
        builder
            .setup(platform::setup)
            .build(tauri::generate_context!()),
    ) else {
        return;
    };

    // SIGTERM/SIGINT (kill, session end, Ctrl+C in a terminal) normally
    // terminate the process immediately, skipping the graceful-exit
    // machinery (frontend flush, journal coordination). Route them through
    // the normal exit flow: app.exit() fires RunEvent::ExitRequested, which
    // the handler below routes to platform::request_graceful_exit.
    #[cfg(all(unix, not(target_os = "android")))]
    {
        let app_handle_for_signal = app.handle().clone();
        if let Err(error) = ctrlc::set_handler(move || {
            app_handle_for_signal.exit(0);
        }) {
            eprintln!("could not install SIGTERM/SIGINT handler: {error}");
        }
    }

    app.run(|app_handle, event| {
        #[cfg(not(target_os = "android"))]
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && !platform::exit_is_permitted(app_handle)
        {
            api.prevent_exit();
            platform::request_graceful_exit(app_handle);
        }
    });
}

#[cfg(test)]
mod startup_tests {
    use super::app_or_log_error;

    #[test]
    fn startup_build_errors_return_without_panicking() {
        assert_eq!(app_or_log_error::<u8, _>(Err("setup failed")), None);
        assert_eq!(app_or_log_error::<_, &str>(Ok(7)), Some(7));
    }
}
