use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::{APP_NAME, HOST, server, store::Store};

use super::SetupResult;

#[cfg(target_os = "linux")]
const LINUX_DESKTOP_APP_ID: &str = "com.wordhunter.app";

pub(crate) fn setup_desktop(app: &mut tauri::App) -> SetupResult {
    let store = Arc::new(Store::new(APP_NAME).map_err(boxed_string)?);
    let token = server::make_token();
    let app_handle = app.handle().clone();
    let port = server::start_server(store, token, app_handle).map_err(boxed_string)?;
    let url = format!("http://{HOST}:{port}/index.html");

    #[cfg(target_os = "linux")]
    set_linux_program_name();

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

    let window = builder.build()?;

    #[cfg(target_os = "linux")]
    install_linux_window_workarounds(&window);

    Ok(())
}

#[cfg(target_os = "linux")]
fn set_linux_program_name() {
    let app_id = std::ffi::CString::new(LINUX_DESKTOP_APP_ID).expect("static app id has no NUL");
    unsafe {
        gtk::glib::ffi::g_set_prgname(app_id.as_ptr());
    }
}

#[cfg(target_os = "linux")]
fn install_linux_window_workarounds(window: &tauri::WebviewWindow) {
    use gtk::prelude::*;

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };

    allow_wayland_titlebar_button_events(&gtk_window);
    gtk_window.connect_realize(|gtk_window| {
        allow_wayland_titlebar_button_events(gtk_window);
        apply_wayland_app_id(gtk_window);
    });
    gtk_window.connect_map(|gtk_window| {
        allow_wayland_titlebar_button_events(gtk_window);
    });

    if gtk_window.is_realized() {
        apply_wayland_app_id(&gtk_window);
    }
}

#[cfg(target_os = "linux")]
fn allow_wayland_titlebar_button_events(gtk_window: &gtk::ApplicationWindow) {
    use gtk::prelude::*;

    let Some(titlebar) = gtk_window.titlebar() else {
        return;
    };
    relax_event_box_overlays(&titlebar);
}

#[cfg(target_os = "linux")]
fn relax_event_box_overlays(widget: &gtk::Widget) {
    use gtk::prelude::*;

    if let Ok(event_box) = widget.clone().downcast::<gtk::EventBox>()
        && event_box.is_above_child()
    {
        event_box.set_above_child(false);
    }

    if let Ok(container) = widget.clone().downcast::<gtk::Container>() {
        for child in container.children() {
            relax_event_box_overlays(&child);
        }
    }
}

#[cfg(target_os = "linux")]
fn apply_wayland_app_id(gtk_window: &gtk::ApplicationWindow) {
    use gtk::glib::translate::from_glib;
    use gtk::prelude::*;

    let Some(gdk_window) = gtk_window.window() else {
        return;
    };

    let wayland_window_type: gtk::glib::Type =
        unsafe { from_glib(gdk_wayland_sys::gdk_wayland_window_get_type()) };
    if !gdk_window.type_().is_a(wayland_window_type) {
        return;
    }

    let app_id = std::ffi::CString::new(LINUX_DESKTOP_APP_ID).expect("static app id has no NUL");
    unsafe {
        gdk_wayland_sys::gdk_wayland_window_set_application_id(
            gdk_window.as_ptr() as *mut gdk_wayland_sys::GdkWaylandWindow,
            app_id.as_ptr(),
        );
    }
}

fn boxed<E>(err: E) -> Box<dyn std::error::Error>
where
    E: std::error::Error + Send + Sync + 'static,
{
    Box::new(err)
}

fn boxed_string(err: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(err))
}
