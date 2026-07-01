use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::{server, store::Store, APP_NAME, HOST};

use super::SetupResult;

pub(crate) fn setup_desktop(app: &mut tauri::App) -> SetupResult {
    let store = Arc::new(Store::new(APP_NAME).map_err(boxed_string)?);
    let token = server::make_token();
    let app_handle = app.handle().clone();
    let port = server::start_server(store, token, app_handle).map_err(boxed_string)?;
    let url = format!("http://{HOST}:{port}/index.html");

    let builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(Url::parse(&url).map_err(boxed)?),
    )
    .title("Word Hunter")
    .inner_size(1360.0, 880.0)
    .min_inner_size(960.0, 640.0);

    let builder = builder
        // ponytail: desktop WebView2 resize race.
        .visible(false)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = window.show();
            }
        });

    builder.build()?;

    Ok(())
}

fn boxed<E>(err: E) -> Box<dyn std::error::Error>
where
    E: std::error::Error + Send + Sync + 'static,
{
    Box::new(err)
}

fn boxed_string(err: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, err))
}
