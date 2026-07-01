use tauri::AppHandle;
use tiny_http::Request;

use crate::response;

pub fn serve_open_dict(
    request: Request,
    _base_url: &str,
    _app_handle: &AppHandle,
    _query: &str,
) -> Result<(), String> {
    response::no_content(request)
}

pub fn serve_close_popup(request: Request, _app_handle: &AppHandle) -> Result<(), String> {
    response::no_content(request)
}
