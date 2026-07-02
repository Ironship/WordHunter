use base64::Engine;
use pdf_extract::{MediaBox, OutputDev, OutputError, Transform};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::AppHandle;

use crate::store::Store;

mod runner;

const MAX_PDF_BYTES: usize = 1024 * 1024 * 1024;
const MAX_PAGES: u64 = 2_000;
const TEXT_LAYER_RENDER_WIDTH: u32 = 1400;
const TEXT_LAYER_BOUNDS_VERSION: &str = "text-glyph-v2";

pub fn import(
    payload: Value,
    store: &Store,
    app_handle: &AppHandle,
    cancellations: &Mutex<HashSet<String>>,
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
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or("PDF OCR");
    let data_url = payload.get("data").and_then(Value::as_str).unwrap_or("");
    let data = decode_payload(data_url)?;

    let lang = requested_lang(&payload);
    let max_pages = payload
        .get("max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(MAX_PAGES);

    let runner_path = match runner::find_runner(app_handle) {
        Ok(path) => path,
        Err(runner_error) => {
            return import_text_layer_pdf(
                filename,
                &data,
                max_pages,
                &runner_error,
                store,
                book_id,
            );
        }
    };

    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    let pages_dir = temp.path().join("pages");
    let json_path = temp.path().join("ocr.json");
    fs::create_dir_all(&pages_dir).map_err(|e| e.to_string())?;
    fs::write(&input_path, data).map_err(|e| e.to_string())?;

    let result = runner::run_runner(
        &runner_path,
        &input_path,
        &pages_dir,
        &json_path,
        &lang,
        max_pages,
        temp.path(),
        job_id,
        cancellations,
    );
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .remove(job_id);
    result?;

    let output = read_runner_output(&json_path)?;
    let mut pages = output
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "PaddleOCR runner did not return a pages array".to_string())?;
    if pages.is_empty() {
        return Err("PaddleOCR did not return any pages".to_string());
    }

    let mut text_parts = Vec::new();
    for page in &mut pages {
        let image_name = page
            .get("imageName")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "PaddleOCR page is missing imageName".to_string())?;
        let safe_image_name = crate::paths::sanitize_id(image_name)?;
        let image_path = pages_dir.join(&safe_image_name);
        let image_bytes = fs::read(&image_path)
            .map_err(|e| format!("could not read OCR page image {safe_image_name}: {e}"))?;
        store.save_book_image_bytes(book_id, &safe_image_name, &image_bytes)?;
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
    filename: &str,
    data: &[u8],
    max_pages: u64,
    runner_error: &str,
    store: &Store,
    book_id: &str,
) -> Result<Value, String> {
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
    if readable_chars(&text) < 3 {
        return Err(format!(
            "{runner_error}\nPDF text layer is empty; install the bundled OCR runtime to import scanned PDFs."
        ));
    }
    render_text_layer_page_images(data, store, book_id, &pages)
        .map_err(|render_error| format!("{runner_error}\n{render_error}"))?;

    Ok(json!({
        "title": title_from_filename(filename),
        "text": text,
        "coverDataUrl": "",
        "pages": pages,
        "pageCount": page_count,
        "truncated": truncated,
        "ocrEngine": "pdf-text-layer+pdftoppm",
        "experimental": true,
        "blurb": ""
    }))
}

fn extract_text_layer_overlay_pages(
    data: &[u8],
    max_pages: usize,
) -> Result<(Vec<OverlayPage>, u64, bool), String> {
    let mut document = pdf_extract::Document::load_mem(data).map_err(|e| e.to_string())?;
    if document.is_encrypted() {
        document.decrypt("").map_err(|e| e.to_string())?;
    }
    let page_numbers = document.get_pages().keys().copied().collect::<Vec<_>>();
    let page_count = page_numbers.len();
    let limit = if max_pages == 0 {
        page_count
    } else {
        max_pages.min(page_count)
    };
    let plain_text_by_page = pdf_extract::extract_text_from_mem_by_pages(data).unwrap_or_default();
    let mut output = PositionedTextOutput::new(plain_text_by_page);
    for page_num in page_numbers.into_iter().take(limit) {
        pdf_extract::output_doc_page(&document, &mut output, page_num)
            .map_err(|e| format!("Could not read PDF page {page_num}: {e}"))?;
    }
    Ok((output.pages, page_count as u64, limit < page_count))
}

fn render_text_layer_page_images(
    data: &[u8],
    store: &Store,
    book_id: &str,
    pages: &[OverlayPage],
) -> Result<(), String> {
    let renderer = find_pdftoppm()?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input_path = temp.path().join("input.pdf");
    fs::write(&input_path, data).map_err(|e| e.to_string())?;

    for page in pages {
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
        let output = command.output().map_err(|e| {
            format!(
                "Could not start PDF page renderer {}: {e}",
                renderer.path.display()
            )
        })?;
        if !output.status.success() {
            return Err(format!(
                "PDF page renderer failed for page {} with exit code {}.\n{}",
                page.page,
                output
                    .status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let image_path = output_prefix.with_extension("png");
        let image_bytes = fs::read(&image_path)
            .map_err(|e| format!("Could not read rendered PDF page {}: {e}", page.page))?;
        store.save_book_image_bytes(book_id, &page.image_name, &image_bytes)?;
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
    if let Ok(path) = std::env::var("WORDHUNTER_PDFTOPPM") {
        if !path.trim().is_empty() {
            candidates.push(PdfToPpm {
                path: PathBuf::from(path),
                host_libraries: false,
            });
        }
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
    if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
        if !existing.trim().is_empty() {
            paths.push(existing);
        }
    }
    paths.join(":")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPage {
    page: u32,
    image_name: String,
    width: f32,
    height: f32,
    text: String,
    bounds_version: &'static str,
    lines: Vec<OverlayLine>,
    words: Vec<OverlayWord>,
}

#[derive(Clone, Debug, Serialize)]
struct OverlayWord {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Debug, Serialize)]
struct OverlayLine {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Default)]
struct PositionedTextOutput {
    pages: Vec<OverlayPage>,
    current: Option<WorkingPage>,
    plain_text_by_page: Vec<String>,
}

impl PositionedTextOutput {
    fn new(plain_text_by_page: Vec<String>) -> Self {
        Self {
            pages: Vec::new(),
            current: None,
            plain_text_by_page,
        }
    }

    fn plain_text_for_page(&self, page_num: u32) -> &str {
        page_num
            .checked_sub(1)
            .and_then(|index| self.plain_text_by_page.get(index as usize))
            .map(String::as_str)
            .unwrap_or("")
    }
}

struct WorkingPage {
    page_num: u32,
    width: f32,
    height: f32,
    chars: Vec<CharBox>,
    flip_ctm: Transform,
}

#[derive(Clone)]
struct CharBox {
    text: String,
    bounds: Bounds,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl Bounds {
    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    fn width(self) -> f32 {
        (self.right - self.left).max(1.0)
    }

    fn height(self) -> f32 {
        (self.bottom - self.top).max(1.0)
    }
}

impl OutputDev for PositionedTextOutput {
    fn begin_page(
        &mut self,
        page_num: u32,
        media_box: &MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), OutputError> {
        let width = (media_box.urx - media_box.llx).max(1.0) as f32;
        let height = (media_box.ury - media_box.lly).max(1.0) as f32;
        self.current = Some(WorkingPage {
            page_num,
            width,
            height,
            chars: Vec::new(),
            flip_ctm: Transform::row_major(1.0, 0.0, 0.0, -1.0, 0.0, height as f64),
        });
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        let Some(page) = self.current.take() else {
            return Ok(());
        };
        let plain_text = self.plain_text_for_page(page.page_num);
        let words = split_words_using_plain_text(
            merge_words_using_plain_text(
                words_from_chars(&page.chars, page.width, page.height),
                plain_text,
            ),
            plain_text,
        );
        let lines = lines_from_words(&words);
        let text = clean_plain_page_text(plain_text).unwrap_or_else(|| {
            lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        });
        self.pages.push(OverlayPage {
            page: page.page_num,
            image_name: format!("pdf-page-{:04}.png", page.page_num),
            width: page.width,
            height: page.height,
            text,
            bounds_version: TEXT_LAYER_BOUNDS_VERSION,
            lines,
            words,
        });
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        text: &str,
    ) -> Result<(), OutputError> {
        let Some(page) = self.current.as_mut() else {
            return Ok(());
        };
        let position = trm.post_transform(&page.flip_ctm);
        let font_height = transformed_font_size(trm, font_size).max(1.0) as f32;
        let glyph_width = (width * font_height as f64).max(0.5) as f32;
        let x = position.m31 as f32;
        let baseline_y = position.m32 as f32;
        let y_top = baseline_y - font_height * 0.82;
        let y_bottom = baseline_y + font_height * 0.22;
        let bounds = Bounds {
            left: x.clamp(0.0, page.width),
            top: y_top.clamp(0.0, page.height),
            right: (x + glyph_width).clamp(0.0, page.width),
            bottom: y_bottom.clamp(0.0, page.height),
        };
        if bounds.right > bounds.left && bounds.bottom > bounds.top {
            page.chars.push(CharBox {
                text: text.to_string(),
                bounds,
            });
        }
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
}

fn transformed_font_size(transform: &Transform, font_size: f64) -> f64 {
    let sx = (transform.m11.powi(2) + transform.m12.powi(2)).sqrt();
    let sy = (transform.m21.powi(2) + transform.m22.powi(2)).sqrt();
    (font_size * ((sx + sy) / 2.0)).abs()
}

fn words_from_chars(chars: &[CharBox], page_width: f32, page_height: f32) -> Vec<OverlayWord> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut current_bounds: Option<Bounds> = None;
    let mut last_bounds: Option<Bounds> = None;
    let mut pending_space = false;

    for item in chars {
        if item.text.chars().all(char::is_whitespace) {
            if !current.is_empty() {
                pending_space = true;
            }
            continue;
        }

        if let Some(previous) = last_bounds {
            let should_break = if pending_space {
                text_space_is_word_break(&current, previous, &item.text, item.bounds)
            } else {
                text_gap_is_word_break(&current, previous, item.bounds)
            };
            if should_break {
                push_overlay_word(
                    &mut words,
                    &mut current,
                    &mut current_bounds,
                    page_width,
                    page_height,
                );
            }
        }
        pending_space = false;

        current.push_str(&item.text);
        current_bounds = Some(match current_bounds {
            Some(bounds) => bounds.union(item.bounds),
            None => item.bounds,
        });
        last_bounds = Some(item.bounds);
    }

    push_overlay_word(
        &mut words,
        &mut current,
        &mut current_bounds,
        page_width,
        page_height,
    );
    words
}

fn merge_words_using_plain_text(words: Vec<OverlayWord>, plain_text: &str) -> Vec<OverlayWord> {
    let lookup_text = normalize_pdf_text_for_lookup(plain_text);
    if lookup_text.is_empty() || words.len() < 2 {
        return words;
    }

    let mut merged: Vec<OverlayWord> = Vec::with_capacity(words.len());
    for word in words {
        if let Some(previous) = merged.last_mut() {
            let previous_bounds = word_bounds(previous);
            let word_bounds = word_bounds(&word);
            if word_bounds_same_line(previous_bounds, word_bounds)
                && should_merge_words_from_plain_text(
                    &previous.text,
                    &word.text,
                    previous_bounds,
                    word_bounds,
                    &lookup_text,
                )
            {
                merge_overlay_words(previous, &word);
                continue;
            }
        }
        merged.push(word);
    }
    merged
}

fn split_words_using_plain_text(words: Vec<OverlayWord>, plain_text: &str) -> Vec<OverlayWord> {
    let plain_tokens = plain_tokens_for_alignment(plain_text);
    if plain_tokens.is_empty() || words.is_empty() {
        return words;
    }

    let mut cursor = 0usize;
    let mut split = Vec::with_capacity(words.len());
    for word in words {
        if let Some((start, parts)) = match_word_to_plain_tokens(&word.text, &plain_tokens, cursor)
        {
            cursor = start + parts.len();
            split.extend(split_overlay_word_by_plain_parts(word, &parts));
        } else {
            split.push(word);
        }
    }
    split
}

#[derive(Clone, Debug)]
struct PlainToken {
    text: String,
    key: String,
}

const PLAIN_TOKEN_SCAN_WINDOW: usize = 64;
const PLAIN_TOKEN_JOIN_LIMIT: usize = 128;

fn plain_tokens_for_alignment(plain_text: &str) -> Vec<PlainToken> {
    plain_text
        .split_whitespace()
        .filter_map(|text| {
            let key = alignment_key(text);
            (!key.is_empty()).then(|| PlainToken {
                text: text.to_string(),
                key,
            })
        })
        .collect()
}

fn match_word_to_plain_tokens(
    word: &str,
    tokens: &[PlainToken],
    cursor: usize,
) -> Option<(usize, Vec<String>)> {
    let word_key = alignment_key(word);
    if word_key.is_empty() {
        return None;
    }
    let end = tokens
        .len()
        .min(cursor.saturating_add(PLAIN_TOKEN_SCAN_WINDOW));
    for start in cursor..end {
        if let Some(parts) = match_word_at_plain_token(&word_key, tokens, start) {
            return Some((start, parts));
        }
    }
    None
}

fn match_word_at_plain_token(
    word_key: &str,
    tokens: &[PlainToken],
    start: usize,
) -> Option<Vec<String>> {
    let mut joined = String::new();
    let mut parts = Vec::new();
    let end = tokens
        .len()
        .min(start.saturating_add(PLAIN_TOKEN_JOIN_LIMIT));
    for token in &tokens[start..end] {
        joined.push_str(&token.key);
        parts.push(token.text.clone());
        if joined == word_key {
            return Some(parts);
        }
        if !word_key.starts_with(&joined) {
            return None;
        }
    }
    None
}

fn split_overlay_word_by_plain_parts(word: OverlayWord, parts: &[String]) -> Vec<OverlayWord> {
    if parts.len() <= 1 {
        return vec![word];
    }
    let weights = parts
        .iter()
        .map(|part| alignment_key(part).chars().count().max(1) as f32)
        .collect::<Vec<_>>();
    let total_weight: f32 = weights.iter().sum();
    if total_weight <= 0.0 {
        return vec![word];
    }

    let mut output = Vec::with_capacity(parts.len());
    let mut x = word.x;
    let right = word.x + word.width;
    for (index, part) in parts.iter().enumerate() {
        let width = if index + 1 == parts.len() {
            (right - x).max(1.0)
        } else {
            (word.width * (weights[index] / total_weight)).max(1.0)
        };
        output.push(OverlayWord {
            text: part.clone(),
            x,
            y: word.y,
            width,
            height: word.height,
            confidence: word.confidence,
        });
        x += width;
    }
    output
}

fn alignment_key(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '\u{00ad}' | '\u{200b}') && ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn should_merge_words_from_plain_text(
    left: &str,
    right: &str,
    previous: Bounds,
    next: Bounds,
    lookup_text: &str,
) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() || !word_text_can_merge(left, right) {
        return false;
    }
    if !plain_text_word_fragment_can_merge(left, right, pdf_fragment_gap(previous, next)) {
        return false;
    }

    let joined = format!("{left}{right}");
    let spaced = format!("{left} {right}");
    lookup_text.contains(&joined) && !lookup_text.contains(&spaced)
}

fn plain_text_word_fragment_can_merge(left: &str, right: &str, fragment_gap: bool) -> bool {
    if text_ends_with_joining_hyphen(left) {
        return true;
    }
    if !fragment_gap {
        return false;
    }

    let left_len = alphanumeric_len(left);
    let right_len = alphanumeric_len(right);
    let short_left_fragment = left_len <= 2 && right_len >= 3 && starts_with_lowercase(right);
    let short_right_fragment = right_len <= 2 && left_len >= 3 && ends_with_lowercase(left);
    short_left_fragment || short_right_fragment
}

fn pdf_fragment_gap(previous: Bounds, next: Bounds) -> bool {
    horizontal_gap(previous, next) <= previous.height().min(next.height()).clamp(1.0, 48.0) * 0.35
}

fn text_ends_with_joining_hyphen(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|ch| matches!(ch, '-' | '\u{2010}' | '\u{2011}'))
}

fn alphanumeric_len(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn starts_with_lowercase(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_lowercase)
}

fn ends_with_lowercase(text: &str) -> bool {
    text.chars().last().is_some_and(char::is_lowercase)
}

fn merge_overlay_words(left: &mut OverlayWord, right: &OverlayWord) {
    let bounds = word_bounds(left).union(word_bounds(right));
    left.text.push_str(&right.text);
    left.x = bounds.left;
    left.y = bounds.top;
    left.width = bounds.width();
    left.height = bounds.height();
    left.confidence = left.confidence.min(right.confidence);
}

fn normalize_pdf_text_for_lookup(text: &str) -> String {
    let cleaned = text
        .chars()
        .filter(|ch| !matches!(ch, '\u{00ad}' | '\u{200b}'))
        .collect::<String>();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_plain_page_text(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned = normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!cleaned.is_empty()).then_some(cleaned)
}

fn word_text_can_merge(left: &str, right: &str) -> bool {
    let Some(left_char) = left.chars().last() else {
        return false;
    };
    let Some(right_char) = right.chars().next() else {
        return false;
    };
    (left_char.is_alphanumeric() || matches!(left_char, '-' | '\u{2010}' | '\u{2011}'))
        && right_char.is_alphanumeric()
}

fn push_overlay_word(
    words: &mut Vec<OverlayWord>,
    current: &mut String,
    current_bounds: &mut Option<Bounds>,
    page_width: f32,
    page_height: f32,
) {
    let text = current.trim().to_string();
    current.clear();
    let Some(bounds) = current_bounds.take() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    let bounds = expand_word_bounds(bounds, page_width, page_height);
    words.push(OverlayWord {
        text,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width(),
        height: bounds.height(),
        confidence: 1.0,
    });
}

fn text_space_is_word_break(
    current: &str,
    previous: Bounds,
    next_text: &str,
    next: Bounds,
) -> bool {
    if bounds_are_on_different_lines(previous, next) {
        return true;
    }
    let gap = horizontal_gap(previous, next);
    if gap <= false_space_gap(previous, next)
        && chars_can_merge_across_pdf_space(current, next_text)
    {
        return false;
    }
    true
}

fn text_gap_is_word_break(current: &str, previous: Bounds, next: Bounds) -> bool {
    if bounds_are_on_different_lines(previous, next) {
        return true;
    }
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    horizontal_gap(previous, next) > missing_space_gap(previous, next)
        && char_can_join_word(previous_char)
}

fn lines_from_words(words: &[OverlayWord]) -> Vec<OverlayLine> {
    let mut lines = Vec::new();
    let mut current_words: Vec<OverlayWord> = Vec::new();

    for word in words {
        let same_line = current_words
            .last()
            .map(|previous| word_bounds_same_line(word_bounds(previous), word_bounds(word)))
            .unwrap_or(true);
        if !same_line {
            push_overlay_line(&mut lines, &mut current_words);
        }
        current_words.push(word.clone());
    }
    push_overlay_line(&mut lines, &mut current_words);
    lines
}

fn push_overlay_line(lines: &mut Vec<OverlayLine>, current_words: &mut Vec<OverlayWord>) {
    if current_words.is_empty() {
        return;
    }
    let mut bounds = word_bounds(&current_words[0]);
    let text = current_words
        .iter()
        .map(|word| {
            bounds = bounds.union(word_bounds(word));
            word.text.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(OverlayLine {
        text,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width(),
        height: bounds.height(),
        confidence: 1.0,
    });
    current_words.clear();
}

fn word_bounds(word: &OverlayWord) -> Bounds {
    Bounds {
        left: word.x,
        top: word.y,
        right: word.x + word.width,
        bottom: word.y + word.height,
    }
}

fn expand_word_bounds(bounds: Bounds, page_width: f32, page_height: f32) -> Bounds {
    let side_room = (bounds.width() * 0.015).clamp(0.25, 2.0);
    Bounds {
        left: (bounds.left - side_room).max(0.0),
        top: bounds.top.max(0.0),
        right: (bounds.right + side_room).min(page_width),
        bottom: bounds.bottom.min(page_height),
    }
}

fn bounds_are_on_different_lines(previous: Bounds, next: Bounds) -> bool {
    let overlap = (previous.bottom.min(next.bottom) - previous.top.max(next.top)).max(0.0);
    let min_height = previous.height().min(next.height()).max(1.0);
    let top_delta = (next.top - previous.top).abs();
    overlap / min_height < 0.45 && top_delta > min_height * 0.55
}

fn word_bounds_same_line(previous: Bounds, next: Bounds) -> bool {
    !bounds_are_on_different_lines(previous, next)
}

fn horizontal_gap(previous: Bounds, next: Bounds) -> f32 {
    (next.left - previous.right).max(0.0)
}

fn false_space_gap(previous: Bounds, next: Bounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.16
}

fn missing_space_gap(previous: Bounds, next: Bounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.28
}

fn char_can_join_word(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '\'' | '-')
}

fn chars_can_merge_across_pdf_space(current: &str, next_text: &str) -> bool {
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    let Some(next_char) = next_text.chars().next() else {
        return false;
    };
    previous_char.is_alphabetic() && next_char.is_alphabetic()
}

pub fn cancel(payload: Value, cancellations: &Mutex<HashSet<String>>) -> Result<(), String> {
    let job_id = payload
        .get("job_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "job_id required".to_string())?;
    cancellations
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?
        .insert(job_id.to_string());
    Ok(())
}

pub fn gpu_status(app_handle: &AppHandle) -> Value {
    runner::GPU_STATUS
        .get_or_init(|| runner::probe_gpu_status(app_handle))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::{
        Bounds, OverlayWord, merge_words_using_plain_text, runner, split_words_using_plain_text,
        text_gap_is_word_break,
    };

    #[test]
    fn gpu_status_uses_safe_cpu_states() {
        assert_eq!(runner::gpu_status_value("ready")["status"], "ready");
        assert_eq!(
            runner::gpu_status_value("unavailable")["status"],
            "unavailable"
        );
        assert_eq!(runner::gpu_status_value("unexpected")["status"], "failed");
    }

    #[test]
    fn linux_gpu_status_does_not_require_ocr_runner() {
        #[cfg(not(windows))]
        assert_eq!(
            runner::platform_gpu_status_without_runner().unwrap()["status"],
            "unavailable"
        );
    }

    #[test]
    fn text_layer_merges_short_false_space_after_initial_letter() {
        let words = vec![
            test_word("W", 10.0, 20.0, 8.0, 10.0),
            test_word("eltmeisterschaftsstatus", 21.0, 20.0, 61.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "Rennen ohne Weltmeisterschaftsstatus");

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "Weltmeisterschaftsstatus");
    }

    #[test]
    fn text_layer_keeps_normal_words_when_plain_text_lacks_spaces() {
        let words = vec![
            test_word("mindestens", 10.0, 20.0, 70.0, 10.0),
            test_word("zwei", 84.0, 20.0, 24.0, 10.0),
            test_word("stunden", 112.0, 20.0, 42.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "mindestenszweistunden");

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].text, "mindestens");
        assert_eq!(merged[1].text, "zwei");
        assert_eq!(merged[2].text, "stunden");
    }

    #[test]
    fn text_layer_splits_joined_words_using_plain_text() {
        let words = vec![test_word(
            "Konstrukteursweltmeisterschaftwerden",
            10.0,
            20.0,
            160.0,
            10.0,
        )];
        let split = split_words_using_plain_text(
            words,
            "Fahrer- und Konstrukteursweltmeisterschaft werden parallel ermittelt",
        );
        let texts = split
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>();

        assert_eq!(texts, vec!["Konstrukteursweltmeisterschaft", "werden"]);
        assert!(split[0].width < 160.0);
        assert!(split[1].x > split[0].x);
    }

    #[test]
    fn text_layer_keeps_hyphenated_compound_from_plain_text() {
        let words = vec![test_word(
            "Automobil-Weltmeisterschaft",
            10.0,
            20.0,
            120.0,
            10.0,
        )];
        let split = split_words_using_plain_text(
            words,
            "Die Formel-1-Weltmeisterschaft (bis 1980 Automobil-Weltmeisterschaft) wird",
        );

        assert_eq!(split.len(), 1);
        assert_eq!(split[0].text, "Automobil-Weltmeisterschaft");
    }

    #[test]
    fn text_layer_recovers_alignment_after_wide_chart_token() {
        let words = vec![
            test_word("0123456789012345", 10.0, 20.0, 160.0, 10.0),
            test_word("DieReifengehören", 10.0, 40.0, 120.0, 10.0),
        ];
        let split = split_words_using_plain_text(
            words,
            "0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 Die Reifen gehören",
        );
        let texts = split
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>();

        assert_eq!(&texts[texts.len() - 3..], &["Die", "Reifen", "gehören"]);
    }

    #[test]
    fn text_layer_splits_missing_space_on_normal_visual_gap() {
        let previous = Bounds {
            left: 10.0,
            top: 20.0,
            right: 80.0,
            bottom: 30.0,
        };
        let next = Bounds {
            left: 84.0,
            top: 20.0,
            right: 108.0,
            bottom: 30.0,
        };

        assert!(text_gap_is_word_break("mindestens", previous, next));
    }

    fn test_word(text: &str, x: f32, y: f32, width: f32, height: f32) -> OverlayWord {
        OverlayWord {
            text: text.to_string(),
            x,
            y,
            width,
            height,
            confidence: 1.0,
        }
    }
}

fn decode_payload(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    if encoded.len() > MAX_PDF_BYTES.saturating_mul(4) / 3 + 4 {
        return Err("PDF is too large (max 1 GB)".to_string());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_PDF_BYTES {
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

fn read_runner_output(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("PaddleOCR runner did not write OCR JSON: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("PaddleOCR runner wrote invalid JSON: {e}"))
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
