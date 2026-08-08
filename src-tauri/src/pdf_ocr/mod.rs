#[cfg(test)]
use base64::Engine;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::AppHandle;

use crate::pdf_text_layer::{self, OverlayPage};
use crate::server::OcrJobState;
use crate::store::Store;

mod runner;

const MAX_PDF_BYTES: usize = 1024 * 1024 * 1024;
const MAX_OCR_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGES: u64 = 2_000;
const TEXT_LAYER_RENDER_WIDTH: u32 = 1400;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OcrImageFormat {
    Jpeg,
    Png,
    WebP,
}

impl OcrImageFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::WebP => "webp",
        }
    }
}

struct ImportContext<'a> {
    filename: &'a str,
    store: &'a Store,
    asset_book_id: &'a str,
    job_id: &'a str,
    jobs: &'a Mutex<OcrJobState>,
}

struct FailedImportAssetCleanup<'a> {
    store: &'a Store,
    book_id: &'a str,
    completed: bool,
}

impl Drop for FailedImportAssetCleanup<'_> {
    fn drop(&mut self) {
        if !self.completed
            && let Err(error) = self.store.discard_book_import_assets(self.book_id)
        {
            eprintln!(
                "Could not clean failed OCR assets for {}: {error}",
                self.book_id
            );
        }
    }
}

pub fn import_bytes(
    payload: Value,
    data: Vec<u8>,
    store: &Store,
    app_handle: &AppHandle,
    jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    if data.len() > MAX_PDF_BYTES {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    import_decoded(payload, data, store, app_handle, jobs)
}

pub fn import_image_bytes(
    payload: Value,
    data: Vec<u8>,
    store: &Store,
    app_handle: &AppHandle,
    jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("Image OCR is only packaged for Windows and Linux".to_string());
    }
    if data.len() > MAX_OCR_IMAGE_BYTES {
        return Err("Image is too large (max 32 MB)".to_string());
    }
    let format = validate_ocr_image(&payload, &data)?;
    let book_id = required_payload_string(&payload, "book_id")?;
    let job_id = required_payload_string(&payload, "job_id")?;
    ensure_not_cancelled(job_id, jobs)?;
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("OCR image");
    store.ensure_new_book_import_id(book_id)?;
    let asset_book_id = format!("ocr-import-{:016x}", rand::random::<u64>());
    store.ensure_new_book_import_id(&asset_book_id)?;
    let mut asset_cleanup = FailedImportAssetCleanup {
        store,
        book_id: &asset_book_id,
        completed: false,
    };
    let runner_path = runner::find_runner(app_handle).map_err(|error| {
        format!(
            "Image OCR requires the bundled PaddleOCR component. Reinstall Word Hunter if the problem persists.\n{error}"
        )
    })?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join(format!("input.{}", format.extension()));
    let pages_dir = temp.path().join("pages");
    let json_path = temp.path().join("ocr.json");
    fs::create_dir_all(&pages_dir).map_err(|e| e.to_string())?;
    fs::write(&input_path, &data).map_err(|e| e.to_string())?;
    let lang = requested_lang(&payload);

    runner::run_runner(
        &runner_path,
        runner::RunnerJob {
            input_path: &input_path,
            pages_dir: &pages_dir,
            json_path: &json_path,
            lang: &lang,
            max_pages: 1,
            work_dir: temp.path(),
            job_id,
            jobs,
        },
    )
    .map_err(|error| {
        if error.to_ascii_lowercase().contains("cancel") {
            error
        } else {
            format!(
                "The bundled OCR component failed while processing this image. Reinstall Word Hunter if the problem persists.\n{error}"
            )
        }
    })?;

    let output = read_runner_output(&json_path)?;
    let mut pages = runner_pages(&output)?;
    if pages.len() != 1 {
        return Err("PaddleOCR returned an invalid image page count".to_string());
    }
    let page = &mut pages[0];
    ensure_not_cancelled(job_id, jobs)?;
    let image_name = crate::paths::sanitize_id(runner_image_name(page)?)?;
    let image_bytes = fs::read(pages_dir.join(&image_name))
        .map_err(|e| format!("could not read OCR image {image_name}: {e}"))?;
    store.save_book_import_image_bytes(&asset_book_id, &image_name, &image_bytes)?;
    if let Some(object) = page.as_object_mut() {
        object.insert("imageName".to_string(), json!(image_name));
    }
    let text = extract_page_text(page).trim().to_string();
    if text.is_empty() {
        return Err("PaddleOCR did not find readable text in this image".to_string());
    }
    let ocr_engine = output
        .get("ocrEngine")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("paddleocr-rs-onnx");
    ensure_not_cancelled(job_id, jobs)?;
    store.finalize_book_import_assets(&asset_book_id, book_id)?;
    asset_cleanup.completed = true;
    Ok(json!({
        "title": title_from_filename(filename),
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": 1,
        "truncated": false,
        "ocrEngine": ocr_engine,
        "experimental": true,
        "blurb": ""
    }))
}

fn required_payload_string<'a>(payload: &'a Value, key: &str) -> Result<&'a str, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{key} required"))
}

fn validate_ocr_image(payload: &Value, data: &[u8]) -> Result<OcrImageFormat, String> {
    let detected = detect_ocr_image_format(data).ok_or_else(|| {
        "Unsupported or invalid OCR image; use JPG, JPEG, PNG, or WebP".to_string()
    })?;
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("");
    let extension_format = if let Some(extension) = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
    {
        let from_extension = image_format_from_extension(extension).ok_or_else(|| {
            "Unsupported OCR image filename; use JPG, JPEG, PNG, or WebP".to_string()
        })?;
        if from_extension != detected {
            return Err("OCR image contents do not match the filename extension".to_string());
        }
        Some(from_extension)
    } else {
        None
    };
    let content_type = payload
        .get("content_type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !content_type.is_empty() {
        if let Some(from_content_type) = image_format_from_content_type(&content_type) {
            if from_content_type != detected {
                return Err("OCR image contents do not match the request content type".to_string());
            }
        } else if content_type != "application/octet-stream" || extension_format.is_none() {
            return Err("Unsupported OCR image request content type".to_string());
        }
    }
    Ok(detected)
}

fn image_format_from_content_type(content_type: &str) -> Option<OcrImageFormat> {
    match content_type {
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some(OcrImageFormat::Jpeg),
        "image/png" => Some(OcrImageFormat::Png),
        "image/webp" => Some(OcrImageFormat::WebP),
        _ => None,
    }
}

fn image_format_from_extension(extension: &str) -> Option<OcrImageFormat> {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some(OcrImageFormat::Jpeg),
        "png" => Some(OcrImageFormat::Png),
        "webp" => Some(OcrImageFormat::WebP),
        _ => None,
    }
}

fn detect_ocr_image_format(data: &[u8]) -> Option<OcrImageFormat> {
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(OcrImageFormat::Jpeg)
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(OcrImageFormat::Png)
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        Some(OcrImageFormat::WebP)
    } else {
        None
    }
}

fn import_decoded(
    payload: Value,
    data: Vec<u8>,
    store: &Store,
    app_handle: &AppHandle,
    jobs: &Mutex<OcrJobState>,
) -> Result<Value, String> {
    let book_id = payload
        .get("book_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "book_id required".to_string())?;
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    if jobs
        .lock()
        .map_err(|_| "OCR job state is unavailable".to_string())?
        .is_cancelled(job_id)
    {
        return Err("PaddleOCR import cancelled".to_string());
    }
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("PDF OCR");
    store.ensure_new_book_import_id(book_id)?;
    let asset_book_id = format!("ocr-import-{:016x}", rand::random::<u64>());
    store.ensure_new_book_import_id(&asset_book_id)?;
    let lang = requested_lang(&payload);
    let max_pages = requested_max_pages(&payload);
    let context = ImportContext {
        filename,
        store,
        asset_book_id: &asset_book_id,
        job_id,
        jobs,
    };
    let mut asset_cleanup = FailedImportAssetCleanup {
        store,
        book_id: &asset_book_id,
        completed: false,
    };

    let runner_path = match runner::find_runner(app_handle) {
        Ok(path) => path,
        Err(runner_error) => {
            let result = import_text_layer_pdf(&data, max_pages, &runner_error, &context);
            if result.is_ok() {
                store.finalize_book_import_assets(&asset_book_id, book_id)?;
                asset_cleanup.completed = true;
            }
            return result;
        }
    };

    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    let pages_dir = temp.path().join("pages");
    let json_path = temp.path().join("ocr.json");
    fs::create_dir_all(&pages_dir).map_err(|e| e.to_string())?;
    fs::write(&input_path, &data).map_err(|e| e.to_string())?;

    let result = runner::run_runner(
        &runner_path,
        runner::RunnerJob {
            input_path: &input_path,
            pages_dir: &pages_dir,
            json_path: &json_path,
            lang: &lang,
            max_pages,
            work_dir: temp.path(),
            job_id,
            jobs,
        },
    );
    if let Err(runner_error) = result {
        if runner_error.to_ascii_lowercase().contains("cancel") {
            return Err(runner_error);
        }
        return Err(format!(
            "The bundled OCR component failed while processing this PDF. Reinstall Word Hunter if the problem persists.\n{runner_error}"
        ));
    }

    let output = read_runner_output(&json_path)?;
    let mut pages = runner_pages(&output)?;

    let mut text_parts = Vec::new();
    for page in &mut pages {
        ensure_not_cancelled(job_id, jobs)?;
        let image_name = runner_image_name(page)?;
        let safe_image_name = crate::paths::sanitize_id(image_name)?;
        let image_path = pages_dir.join(&safe_image_name);
        let image_bytes = fs::read(&image_path)
            .map_err(|e| format!("could not read OCR page image {safe_image_name}: {e}"))?;
        store.save_book_import_image_bytes(&asset_book_id, &safe_image_name, &image_bytes)?;
        if let Some(obj) = page.as_object_mut() {
            obj.insert("imageName".to_string(), json!(safe_image_name));
        }

        let page_text = extract_page_text(page);
        if !page_text.is_empty() {
            text_parts.push(page_text);
        }
    }

    let text = text_parts.join("\n\n").trim().to_string();
    if text.is_empty() {
        return Err("PaddleOCR did not find readable text in this PDF".to_string());
    }

    let page_count = output
        .get("pageCount")
        .and_then(Value::as_u64)
        .unwrap_or(pages.len() as u64);
    let truncated = output
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(page_count > pages.len() as u64);
    let ocr_engine = output
        .get("ocrEngine")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("paddleocr-cpp");
    let title = title_from_filename(filename);

    ensure_not_cancelled(job_id, jobs)?;
    store.finalize_book_import_assets(&asset_book_id, book_id)?;
    asset_cleanup.completed = true;
    Ok(json!({
        "title": title,
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": page_count,
        "truncated": truncated,
        "ocrEngine": ocr_engine,
        "experimental": true,
        "blurb": ""
    }))
}

fn import_text_layer_pdf(
    data: &[u8],
    max_pages: u64,
    runner_error: &str,
    context: &ImportContext<'_>,
) -> Result<Value, String> {
    ensure_not_cancelled(context.job_id, context.jobs)?;
    let (pages, page_count, truncated) = extract_text_layer_overlay_pages(data, max_pages as usize)
        .map_err(|text_error| {
            format!("{runner_error}\nCould not read the PDF text layer either: {text_error}")
        })?;
    let text = pages
        .iter()
        .map(|page| page.text.trim())
        .filter(|page| !page.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let incomplete_page = pages.iter().any(|page| readable_chars(&page.text) < 3);
    if readable_chars(&text) < 3 || incomplete_page {
        return Err(format!(
            "{runner_error}\nAt least one PDF page has no readable text layer, and the bundled OCR component is unavailable. Reinstall Word Hunter if the problem persists."
        ));
    }
    let (pages, ocr_engine, experimental) = match render_text_layer_page_images(
        data,
        context.store,
        context.asset_book_id,
        &pages,
        context.job_id,
        context.jobs,
    ) {
        Ok(()) => (pages, "pdf-text-layer+pdftoppm", true),
        Err(render_error) => {
            ensure_not_cancelled(context.job_id, context.jobs)?;
            if render_error.starts_with("Could not save PDF page background:") {
                return Err(render_error);
            }
            eprintln!("PDF page backgrounds unavailable: {runner_error}; {render_error}");
            (Vec::new(), "pdf-text-layer", false)
        }
    };

    Ok(json!({
        "title": title_from_filename(context.filename),
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": page_count,
        "truncated": truncated,
        "ocrEngine": ocr_engine,
        "experimental": experimental,
        "blurb": ""
    }))
}

fn extract_text_layer_overlay_pages(
    data: &[u8],
    max_pages: usize,
) -> Result<(Vec<OverlayPage>, u64, bool), String> {
    let (pages, page_count, truncated) =
        pdf_text_layer::extract_overlay_pages(data, max_pages, None)?;
    Ok((pages, page_count as u64, truncated))
}

fn render_text_layer_page_images(
    data: &[u8],
    store: &Store,
    book_id: &str,
    pages: &[OverlayPage],
    job_id: &str,
    jobs: &Mutex<OcrJobState>,
) -> Result<(), String> {
    let renderer = find_pdftoppm()?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    fs::write(&input_path, data).map_err(|e| e.to_string())?;
    let mut rendered_pages = Vec::with_capacity(pages.len());

    for page in pages {
        ensure_not_cancelled(job_id, jobs)?;
        let image_stem = page
            .image_name
            .strip_suffix(".png")
            .unwrap_or(&page.image_name);
        let output_prefix = temp.path().join(image_stem);
        let mut command = renderer.command();
        command
            .arg("-png")
            .arg("-scale-to-x")
            .arg(TEXT_LAYER_RENDER_WIDTH.to_string())
            .arg("-scale-to-y")
            .arg("-1")
            .arg("-f")
            .arg(page.page.to_string())
            .arg("-l")
            .arg(page.page.to_string())
            .arg("-singlefile")
            .arg(&input_path)
            .arg(&output_prefix)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let stderr_path = temp.path().join(format!("{image_stem}.stderr.log"));
        let stderr_file = fs::File::create(&stderr_path)
            .map_err(|e| format!("Could not create PDF renderer log: {e}"))?;
        command.stderr(Stdio::from(stderr_file));
        // Never pop a visible console window on Windows when spawning the
        // PDF renderer from the embedded server (CREATE_NO_WINDOW).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| {
            format!(
                "Could not start PDF page renderer {}: {e}",
                renderer.path.display()
            )
        })?;
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        let status = loop {
            if let Err(error) = ensure_not_cancelled(job_id, jobs) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "PDF page renderer timed out for page {} after 120 seconds.",
                    page.page
                ));
            }
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status,
                None => thread::sleep(Duration::from_millis(50)),
            }
        };
        let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "PDF page renderer failed for page {} with exit code {}.\n{}",
                page.page,
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                stderr.trim()
            ));
        }

        let image_path = output_prefix.with_extension("png");
        if !image_path.is_file() {
            return Err(format!("Could not read rendered PDF page {}", page.page));
        }
        rendered_pages.push((&page.image_name, image_path));
    }

    ensure_not_cancelled(job_id, jobs)?;
    for (image_name, image_path) in rendered_pages {
        ensure_not_cancelled(job_id, jobs)?;
        let image_bytes = fs::read(&image_path)
            .map_err(|e| format!("Could not read rendered PDF page {image_name}: {e}"))?;
        store
            .save_book_import_image_bytes(book_id, image_name, &image_bytes)
            .map_err(|e| format!("Could not save PDF page background: {e}"))?;
    }
    ensure_not_cancelled(job_id, jobs)?;

    Ok(())
}

fn ensure_not_cancelled(job_id: &str, jobs: &Mutex<OcrJobState>) -> Result<(), String> {
    if jobs
        .lock()
        .map_err(|_| "OCR job state is unavailable".to_string())?
        .is_cancelled(job_id)
    {
        return Err("PaddleOCR import cancelled".to_string());
    }
    Ok(())
}

#[derive(Clone)]
struct PdfToPpm {
    path: PathBuf,
    host_libraries: bool,
}

impl PdfToPpm {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.path);
        if self.host_libraries {
            command.env("LD_LIBRARY_PATH", host_library_path());
        }
        command
    }
}

fn find_pdftoppm() -> Result<PdfToPpm, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("WORDHUNTER_PDFTOPPM")
        && !path.trim().is_empty()
    {
        candidates.push(PdfToPpm {
            path: PathBuf::from(path),
            host_libraries: false,
        });
    }
    candidates.extend([
        PdfToPpm {
            path: PathBuf::from("pdftoppm"),
            host_libraries: false,
        },
        PdfToPpm {
            path: PathBuf::from("/usr/bin/pdftoppm"),
            host_libraries: false,
        },
        PdfToPpm {
            path: PathBuf::from("/bin/pdftoppm"),
            host_libraries: false,
        },
        PdfToPpm {
            path: PathBuf::from("/run/host/usr/bin/pdftoppm"),
            host_libraries: true,
        },
    ]);

    for candidate in candidates {
        if candidate.path.is_absolute() && !candidate.path.is_file() {
            continue;
        }
        let mut command = candidate.command();
        command
            .arg("-v")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok(candidate);
        }
    }

    Err(
        "PDF text layer was found, but no page renderer was available. Install poppler-utils or run the Flatpak with host-os read access so /run/host/usr/bin/pdftoppm is visible."
            .to_string(),
    )
}

fn host_library_path() -> String {
    let mut paths = vec![
        "/run/host/lib64",
        "/run/host/usr/lib64",
        "/run/host/lib",
        "/run/host/usr/lib",
        "/run/host/lib/x86_64-linux-gnu",
        "/run/host/usr/lib/x86_64-linux-gnu",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if let Ok(existing) = std::env::var("LD_LIBRARY_PATH")
        && !existing.trim().is_empty()
    {
        paths.push(existing);
    }
    paths.join(":")
}

pub fn cancel(payload: Value, jobs: &Mutex<OcrJobState>) -> Result<(), String> {
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    let cancelled = jobs
        .lock()
        .map_err(|_| "OCR job state is unavailable".to_string())?
        .request_cancel(job_id);
    if !cancelled {
        return Err("OCR job is not active".to_string());
    }
    Ok(())
}

pub fn gpu_status(app_handle: &AppHandle) -> Value {
    runner::GPU_STATUS
        .get_or_init(|| runner::probe_gpu_status(app_handle))
        .clone()
}

pub fn image_ocr_available(app_handle: &AppHandle) -> bool {
    cfg!(any(windows, target_os = "linux")) && runner::image_ocr_runtime_available(app_handle)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::sync::Mutex;

    #[cfg(test)]
    use base64::Engine;
    use serde_json::json;

    use crate::server::{ActiveOcrJob, OcrJobState};

    use super::{
        MAX_OCR_IMAGE_BYTES, OcrImageFormat, cancel, decode_payload, decode_payload_with_limit,
        detect_ocr_image_format, extract_text_layer_overlay_pages, image_format_from_content_type,
        requested_max_pages, runner, runner_image_name, runner_pages, validate_ocr_image,
    };

    #[test]
    fn pdf_payload_rejects_invalid_base64_and_enforces_decoded_limits() {
        assert!(decode_payload("%%%not-base64%%%").is_err());
        assert_eq!(
            decode_payload("data:application/pdf;base64,SGk=").unwrap(),
            b"Hi"
        );

        let encoded_over_limit = base64::engine::general_purpose::STANDARD.encode([0u8; 4]);
        assert!(decode_payload_with_limit(&encoded_over_limit, 3).is_err());
        assert!(decode_payload_with_limit("AAAAAAAAA", 3).is_err());
    }

    #[test]
    fn pdf_page_limit_is_clamped() {
        assert_eq!(requested_max_pages(&json!({})), 2_000);
        assert_eq!(requested_max_pages(&json!({ "max_pages": 0 })), 2_000);
        assert_eq!(requested_max_pages(&json!({ "max_pages": 12 })), 12);
        assert_eq!(requested_max_pages(&json!({ "max_pages": 20_000 })), 2_000);
    }

    #[test]
    fn image_ocr_accepts_supported_signatures_and_rejects_spoofed_metadata() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0];
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let webp = b"RIFF\x04\x00\x00\x00WEBPfixture";
        assert_eq!(detect_ocr_image_format(&jpeg), Some(OcrImageFormat::Jpeg));
        assert_eq!(detect_ocr_image_format(png), Some(OcrImageFormat::Png));
        assert_eq!(detect_ocr_image_format(webp), Some(OcrImageFormat::WebP));
        assert_eq!(detect_ocr_image_format(b"GIF89a"), None);
        assert_eq!(MAX_OCR_IMAGE_BYTES, 32 * 1024 * 1024);
        assert_eq!(
            image_format_from_content_type("image/pjpeg"),
            Some(OcrImageFormat::Jpeg)
        );

        assert_eq!(
            validate_ocr_image(
                &json!({ "filename": "scan.JPEG", "content_type": "image/jpeg" }),
                &jpeg,
            )
            .unwrap(),
            OcrImageFormat::Jpeg
        );
        assert!(
            validate_ocr_image(
                &json!({ "filename": "scan.png", "content_type": "image/png" }),
                &jpeg,
            )
            .unwrap_err()
            .contains("filename extension")
        );
        assert!(
            validate_ocr_image(
                &json!({ "filename": "scan.jpg", "content_type": "image/webp" }),
                &jpeg,
            )
            .unwrap_err()
            .contains("content type")
        );
        for content_type in ["image/jpg", "image/pjpeg", "application/octet-stream"] {
            assert_eq!(
                validate_ocr_image(
                    &json!({ "filename": "scan.jpg", "content_type": content_type }),
                    &jpeg,
                )
                .unwrap(),
                OcrImageFormat::Jpeg
            );
        }
        assert!(
            validate_ocr_image(
                &json!({ "filename": "scan", "content_type": "application/octet-stream" }),
                &jpeg,
            )
            .is_err()
        );
    }

    #[test]
    fn cancellation_only_marks_active_jobs_and_cleanup_prevents_late_leaks() {
        let jobs = Mutex::new(OcrJobState::default());

        assert_eq!(cancel(json!({}), &jobs).unwrap_err(), "job_id required");
        assert_eq!(
            cancel(json!({ "job_id": "  " }), &jobs).unwrap_err(),
            "job_id required"
        );
        assert_eq!(
            cancel(json!({ "job_id": "late-job" }), &jobs).unwrap_err(),
            "OCR job is not active"
        );

        {
            let _active = ActiveOcrJob::begin(&jobs, "fixture-job").unwrap();
            std::thread::scope(|scope| {
                scope
                    .spawn(|| cancel(json!({ "job_id": "fixture-job" }), &jobs))
                    .join()
                    .unwrap()
                    .unwrap();
            });
            assert!(jobs.lock().unwrap().is_cancelled("fixture-job"));
            assert!(ActiveOcrJob::begin(&jobs, "fixture-job").is_err());
        }

        assert!(!jobs.lock().unwrap().is_cancelled("fixture-job"));
        assert_eq!(
            cancel(json!({ "job_id": "fixture-job" }), &jobs).unwrap_err(),
            "OCR job is not active"
        );
        ActiveOcrJob::begin(&jobs, "fixture-job").unwrap();
    }

    #[test]
    fn runner_result_requires_nonempty_pages_and_image_names() {
        assert_eq!(
            runner_pages(&json!({})).unwrap_err(),
            "PaddleOCR runner did not return a pages array"
        );
        assert_eq!(
            runner_pages(&json!({ "pages": [] })).unwrap_err(),
            "PaddleOCR did not return any pages"
        );

        let pages = runner_pages(&json!({
            "pages": [{ "imageName": "page-1.png", "text": "Hello" }]
        }))
        .unwrap();
        assert_eq!(runner_image_name(&pages[0]).unwrap(), "page-1.png");
        assert_eq!(
            runner_image_name(&json!({ "imageName": "" })).unwrap_err(),
            "PaddleOCR page is missing imageName"
        );
    }

    #[test]
    fn extracts_a_minimal_pdf_text_layer_without_ocr_models() {
        let pdf = minimal_text_pdf("Fallback text");

        let (pages, page_count, truncated) =
            extract_text_layer_overlay_pages(&pdf, 0).expect("text PDF should parse");

        assert_eq!(page_count, 1);
        assert!(!truncated);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].image_name, "pdf-page-0001.png");
        assert!(
            pages[0].text.contains("Fallback text"),
            "{:?}",
            pages[0].text
        );
    }

    #[test]
    fn gpu_status_uses_safe_cpu_states() {
        assert_eq!(runner::gpu_status_value("ready")["status"], "ready");
        #[cfg(windows)]
        assert_eq!(runner::gpu_status_value("ready")["provider"], "directml");
        #[cfg(target_os = "linux")]
        assert_eq!(runner::gpu_status_value("ready")["provider"], "webgpu");
        assert_eq!(
            runner::gpu_status_value("unavailable")["status"],
            "unavailable"
        );
        assert_eq!(runner::gpu_status_value("unexpected")["status"], "failed");
    }

    #[test]
    fn supported_desktop_gpu_status_requires_the_packaged_runner() {
        #[cfg(any(windows, target_os = "linux"))]
        assert!(runner::platform_gpu_status_without_runner().is_none());
        #[cfg(not(any(windows, target_os = "linux")))]
        assert_eq!(
            runner::platform_gpu_status_without_runner().unwrap()["status"],
            "unavailable"
        );
    }

    fn minimal_text_pdf(text: &str) -> Vec<u8> {
        assert!(text.is_ascii() && !text.chars().any(|ch| matches!(ch, '(' | ')' | '\\')));
        let content = format!("BT /F1 18 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                content.len(),
                content
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref_offset = pdf.len();
        let mut trailer = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for offset in offsets {
            trailer.push_str(&format!("{offset:010} 00000 n \n"));
        }
        trailer.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.extend_from_slice(trailer.as_bytes());
        pdf
    }
}

#[cfg(test)]
fn decode_payload(data_url: &str) -> Result<Vec<u8>, String> {
    decode_payload_with_limit(data_url, MAX_PDF_BYTES)
}

#[cfg(test)]
fn decode_payload_with_limit(data_url: &str, max_pdf_bytes: usize) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    if encoded.len() > max_pdf_bytes.saturating_mul(4) / 3 + 4 {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > max_pdf_bytes {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    Ok(data)
}

fn readable_chars(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn requested_lang(payload: &Value) -> String {
    let lang = payload.get("lang").and_then(Value::as_str).unwrap_or("en");
    let sanitized: String = lang
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(16)
        .collect();
    if sanitized.is_empty() {
        "en".to_string()
    } else {
        sanitized
    }
}

fn requested_max_pages(payload: &Value) -> u64 {
    let requested = payload
        .get("max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_PAGES);
    if requested == 0 {
        MAX_PAGES
    } else {
        requested.min(MAX_PAGES)
    }
}

fn read_runner_output(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("PaddleOCR runner did not write OCR JSON: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("PaddleOCR runner wrote invalid JSON: {e}"))
}

fn runner_pages(output: &Value) -> Result<Vec<Value>, String> {
    let pages = output
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "PaddleOCR runner did not return a pages array".to_string())?;
    if pages.is_empty() {
        return Err("PaddleOCR did not return any pages".to_string());
    }
    Ok(pages)
}

fn runner_image_name(page: &Value) -> Result<&str, String> {
    page.get("imageName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "PaddleOCR page is missing imageName".to_string())
}

fn extract_page_text(page: &Value) -> String {
    if let Some(text) = page
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }

    let words = page
        .get("words")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if !words.is_empty() {
        return words.join(" ");
    }

    page.get("lines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| item.get("text").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn title_from_filename(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("PDF OCR")
        .to_string()
}
