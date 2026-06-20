use anyhow::{bail, Context, Result};
use image::{DynamicImage, ImageFormat, RgbImage};
use ort::execution_providers::DirectMLExecutionProvider;
use paddle_ocr_rs::ocr_lite::OcrLite;
use paddle_ocr_rs::ocr_result::Point;
use pdfium_render::prelude::{PdfRenderConfig, Pdfium};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const ENGINE_NAME: &str = "paddleocr-rs-onnx";

#[derive(Debug)]
struct Args {
    input: Option<PathBuf>,
    output_dir: Option<PathBuf>,
    json: Option<PathBuf>,
    lang: String,
    max_pages: usize,
    models_dir: Option<PathBuf>,
    render_width: i32,
    ocr_max_side: i32,
    threads: usize,
    angle: bool,
    device: DeviceMode,
    gpu_status: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeviceMode {
    Auto,
    Cpu,
    DirectMl,
}

impl DeviceMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "cpu" => Ok(Self::Cpu),
            "directml" => Ok(Self::DirectMl),
            _ => bail!("invalid --device: {value} (expected auto, cpu, or directml)"),
        }
    }
}

#[derive(Serialize)]
struct GpuStatus {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrDocument {
    page_count: usize,
    truncated: bool,
    ocr_engine: String,
    lang: String,
    pages: Vec<OcrPage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrPage {
    page: usize,
    image_name: String,
    width: u32,
    height: u32,
    text: String,
    lines: Vec<OcrLine>,
    words: Vec<OcrWord>,
}

#[derive(Debug, Serialize, Clone)]
struct OcrWord {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Debug, Serialize)]
struct OcrLine {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    if args.gpu_status {
        return write_gpu_status(&args);
    }
    configure_ort(args.device)?;
    let input = args.input.as_ref().context("missing --input")?;
    let output_dir = args.output_dir.as_ref().context("missing --output-dir")?;
    let json_path = args.json.as_ref().context("missing --json")?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("failed to create output directory {}", output_dir.display()))?;

    let models_dir = args
        .models_dir
        .clone()
        .unwrap_or(runtime_root()?.join("models"));
    let mut ocr = load_ocr(&models_dir, args.threads)?;
    let pdfium = load_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(input, None)
        .with_context(|| format!("failed to load PDF {}", input.display()))?;

    let page_count = document.pages().len() as usize;
    let limit = page_limit(args.max_pages, page_count);
    let truncated = limit < page_count;
    let render_config = PdfRenderConfig::new().set_target_width(args.render_width);
    let mut pages = Vec::with_capacity(limit);

    for (index, page) in document.pages().iter().enumerate().take(limit) {
        let page_number = index + 1;
        let image_name = format!("pdf-page-{page_number:04}.png");
        let image_path = output_dir.join(&image_name);
        let rendered = page
            .render_with_config(&render_config)
            .with_context(|| format!("failed to render PDF page {page_number}"))?
            .as_image()
            .with_context(|| format!("failed to convert PDF page {page_number} to image"))?;
        let page_image = to_rgb_image(rendered);
        page_image
            .save_with_format(&image_path, ImageFormat::Png)
            .with_context(|| format!("failed to save page image {}", image_path.display()))?;

        let (lines, words, text) = run_page_ocr(&mut ocr, &page_image, &args)
            .with_context(|| format!("PaddleOCR failed on PDF page {page_number}"))?;
        pages.push(OcrPage {
            page: page_number,
            image_name,
            width: page_image.width(),
            height: page_image.height(),
            text,
            lines,
            words,
        });
    }

    let output = OcrDocument {
        page_count,
        truncated,
        ocr_engine: ENGINE_NAME.to_string(),
        lang: args.lang,
        pages,
    };
    let json = serde_json::to_vec_pretty(&output).context("failed to serialize OCR JSON")?;
    fs::write(json_path, json)
        .with_context(|| format!("failed to write OCR JSON {}", json_path.display()))?;

    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut input = None;
    let mut output_dir = None;
    let mut json = None;
    let mut lang = "auto".to_string();
    let mut max_pages = 50usize;
    let mut models_dir = None;
    let mut render_width = 1800i32;
    let mut ocr_max_side = 1800i32;
    let mut threads = 2usize;
    let mut angle = false;
    let mut device = DeviceMode::Auto;
    let mut gpu_status = false;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => input = Some(next_path(&mut args, "--input")?),
            "--output-dir" => output_dir = Some(next_path(&mut args, "--output-dir")?),
            "--json" => json = Some(next_path(&mut args, "--json")?),
            "--lang" => lang = next_value(&mut args, "--lang")?,
            "--max-pages" => max_pages = parse_next(&mut args, "--max-pages")?,
            "--models-dir" => models_dir = Some(next_path(&mut args, "--models-dir")?),
            "--render-width" => render_width = parse_next(&mut args, "--render-width")?,
            "--ocr-max-side" => ocr_max_side = parse_next(&mut args, "--ocr-max-side")?,
            "--threads" => threads = parse_next(&mut args, "--threads")?,
            "--angle" => angle = true,
            "--device" => device = DeviceMode::parse(&next_value(&mut args, "--device")?)?,
            "--gpu-status" => gpu_status = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            unknown => bail!("unknown argument: {unknown}"),
        }
    }

    if threads == 0 {
        bail!("--threads must be greater than 0");
    }
    if !gpu_status {
        input = Some(input.context("missing --input")?);
        output_dir = Some(output_dir.context("missing --output-dir")?);
        json = Some(json.context("missing --json")?);
        if render_width < 512 {
            bail!("--render-width must be at least 512");
        }
        if ocr_max_side < 512 {
            bail!("--ocr-max-side must be at least 512");
        }
    }

    Ok(Args {
        input,
        output_dir,
        json,
        lang,
        max_pages,
        models_dir,
        render_width,
        ocr_max_side,
        threads,
        angle,
        device,
        gpu_status,
    })
}

fn print_usage() {
    println!(
        "wordhunter-paddleocr --input input.pdf --output-dir pages --json ocr.json [--lang pl] [--max-pages 0] [--device auto|cpu] (0 = all pages)\nwordhunter-paddleocr --gpu-status"
    );
}

fn page_limit(max_pages: usize, page_count: usize) -> usize {
    if max_pages == 0 {
        page_count
    } else {
        max_pages.min(page_count)
    }
}

#[cfg(test)]
mod tests {
    use super::{page_limit, DeviceMode, GpuStatus};
    use serde_json::json;

    #[test]
    fn zero_max_pages_means_all_pages() {
        assert_eq!(page_limit(0, 260), 260);
        assert_eq!(page_limit(30, 260), 30);
    }

    #[test]
    fn parses_device_modes() {
        assert_eq!(DeviceMode::parse("auto").unwrap(), DeviceMode::Auto);
        assert_eq!(DeviceMode::parse("cpu").unwrap(), DeviceMode::Cpu);
        assert_eq!(DeviceMode::parse("directml").unwrap(), DeviceMode::DirectMl);
        assert!(DeviceMode::parse("gpu").is_err());
    }

    #[test]
    fn serializes_gpu_status() {
        assert_eq!(
            serde_json::to_value(GpuStatus { status: "ready" }).unwrap(),
            json!({ "status": "ready" })
        );
    }
}

fn configure_ort(device: DeviceMode) -> Result<()> {
    // TODO(gpu): add Linux and macOS execution providers when their runtimes are bundled.
    let _ = match device {
        DeviceMode::Auto => ort::init()
            .with_execution_providers([DirectMLExecutionProvider::default()
                .build()
                .fail_silently()])
            .commit()?,
        DeviceMode::Cpu => ort::init().commit()?,
        DeviceMode::DirectMl => ort::init()
            .with_execution_providers([DirectMLExecutionProvider::default()
                .build()
                .error_on_failure()])
            .commit()?,
    };
    Ok(())
}

fn write_gpu_status(args: &Args) -> Result<()> {
    let models_dir = args
        .models_dir
        .clone()
        .unwrap_or(runtime_root()?.join("models"));
    let status = if configure_ort(DeviceMode::DirectMl)
        .and_then(|_| load_ocr(&models_dir, args.threads).map(|_| ()))
        .is_ok()
    {
        "ready"
    } else {
        "unavailable"
    };
    println!(
        "{}",
        serde_json::to_string(&GpuStatus { status }).context("failed to serialize GPU status")?
    );
    Ok(())
}

fn next_value(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    args.next()
        .with_context(|| format!("missing value for {name}"))
}

fn next_path(args: &mut impl Iterator<Item = String>, name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(next_value(args, name)?))
}

fn parse_next<T>(args: &mut impl Iterator<Item = String>, name: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let value = next_value(args, name)?;
    value
        .parse::<T>()
        .map_err(|err| anyhow::anyhow!("invalid value for {name}: {value} ({err})"))
}

fn runtime_root() -> Result<PathBuf> {
    let exe = env::current_exe().context("failed to locate current executable")?;
    let exe_dir = exe
        .parent()
        .context("failed to locate executable directory")?;
    if exe_dir.file_name().and_then(|name| name.to_str()) == Some("bin") {
        Ok(exe_dir
            .parent()
            .context("failed to locate OCR runtime directory")?
            .to_path_buf())
    } else {
        Ok(exe_dir.to_path_buf())
    }
}

fn load_ocr(models_dir: &Path, threads: usize) -> Result<OcrLite> {
    let det = find_existing(
        models_dir,
        &[
            "ch_PP-OCRv5_mobile_det.onnx",
            "ch_PP-OCRv4_det_infer.onnx",
            "ch_PP-OCRv4_det_server_infer.onnx",
            "ch_PP-OCRv3_det_infer.onnx",
            "det.onnx",
        ],
        "detection model",
    )?;
    let cls = find_existing(
        models_dir,
        &[
            "ch_ppocr_mobile_v2.0_cls_infer.onnx",
            "ch_ppocr_mobile_v2.0_cls.onnx",
            "cls.onnx",
        ],
        "classification model",
    )?;
    let rec = find_existing(
        models_dir,
        &[
            "ch_PP-OCRv5_rec_mobile_infer.onnx",
            "ch_PP-OCRv5_mobile_rec.onnx",
            "ch_PP-OCRv4_rec_infer.onnx",
            "ch_PP-OCRv3_rec_infer.onnx",
            "rec.onnx",
        ],
        "recognition model",
    )?;
    let dict = find_optional(
        models_dir,
        &[
            "dict.txt",
            "ppocr_keys_v1.txt",
            "ppocrv5_dict.txt",
            "ch_PP-OCRv5_rec_mobile_infer.txt",
        ],
    );

    let mut ocr = OcrLite::new();
    match dict {
        Some(dict) => ocr.init_models_with_dict(
            path_str(&det)?,
            path_str(&cls)?,
            path_str(&rec)?,
            path_str(&dict)?,
            threads,
        )?,
        None => ocr.init_models(path_str(&det)?, path_str(&cls)?, path_str(&rec)?, threads)?,
    }
    Ok(ocr)
}

fn find_existing(models_dir: &Path, names: &[&str], description: &str) -> Result<PathBuf> {
    find_optional(models_dir, names).with_context(|| {
        let expected = names.join(", ");
        format!(
            "missing PaddleOCR {description} in {} (expected one of: {expected})",
            models_dir.display()
        )
    })
}

fn find_optional(models_dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| models_dir.join(name))
        .find(|path| path.is_file())
}

fn path_str(path: &Path) -> Result<&str> {
    path.to_str()
        .with_context(|| format!("path is not valid UTF-8: {}", path.display()))
}

fn load_pdfium() -> Result<Pdfium> {
    let exe = env::current_exe().context("failed to locate current executable")?;
    let exe_dir = exe
        .parent()
        .context("failed to locate executable directory")?;
    let local_library = Pdfium::pdfium_platform_library_name_at_path(exe_dir);
    let bindings = Pdfium::bind_to_library(local_library).or_else(|local_err| {
        Pdfium::bind_to_system_library()
            .with_context(|| format!("failed to load bundled pdfium.dll ({local_err})"))
    })?;
    Ok(Pdfium::new(bindings))
}

fn to_rgb_image(image: DynamicImage) -> RgbImage {
    DynamicImage::ImageRgba8(image.to_rgba8()).into_rgb8()
}

fn run_page_ocr(
    ocr: &mut OcrLite,
    image: &RgbImage,
    args: &Args,
) -> Result<(Vec<OcrLine>, Vec<OcrWord>, String)> {
    let result = ocr.detect(
        image,
        50,
        args.ocr_max_side as u32,
        0.5,
        0.3,
        1.6,
        args.angle,
        false,
    )?;

    let mut lines = Vec::new();
    let mut words = Vec::new();
    let mut text_lines = Vec::new();

    for block in result.text_blocks {
        let text = block.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let (x, y, width, height) =
            rect_from_points(&block.box_points, image.width(), image.height());
        let confidence = block.text_score.clamp(0.0, 1.0);
        lines.push(OcrLine {
            text: text.clone(),
            x,
            y,
            width,
            height,
            confidence,
        });
        words.extend(split_line_into_words(
            &text, x, y, width, height, confidence,
        ));
        text_lines.push(text);
    }

    Ok((lines, words, text_lines.join("\n")))
}

fn rect_from_points(points: &[Point], image_width: u32, image_height: u32) -> (f32, f32, f32, f32) {
    let mut min_x = image_width as f32;
    let mut min_y = image_height as f32;
    let mut max_x = 0.0f32;
    let mut max_y = 0.0f32;

    for point in points {
        min_x = min_x.min(point.x as f32);
        min_y = min_y.min(point.y as f32);
        max_x = max_x.max(point.x as f32);
        max_y = max_y.max(point.y as f32);
    }

    min_x = min_x.clamp(0.0, image_width as f32);
    min_y = min_y.clamp(0.0, image_height as f32);
    max_x = max_x.clamp(min_x, image_width as f32);
    max_y = max_y.clamp(min_y, image_height as f32);
    (
        min_x,
        min_y,
        (max_x - min_x).max(1.0),
        (max_y - min_y).max(1.0),
    )
}

fn split_line_into_words(
    text: &str,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
) -> Vec<OcrWord> {
    let (spans, total_weight) = weighted_word_spans(text);
    if spans.is_empty() {
        return Vec::new();
    }

    let mut words = Vec::with_capacity(spans.len());
    for span in spans {
        let token_x = x + width * (span.start_weight / total_weight);
        let token_width = width * (span.width_weight / total_weight);
        words.push(OcrWord {
            text: span.text,
            x: token_x,
            y,
            width: token_width.max(1.0),
            height,
            confidence,
        });
    }

    words
}

#[derive(Debug)]
struct WordSpan {
    text: String,
    start_weight: f32,
    width_weight: f32,
}

fn weighted_word_spans(text: &str) -> (Vec<WordSpan>, f32) {
    let mut spans = Vec::new();
    let mut cursor = 0.0f32;
    let mut current = String::new();
    let mut current_start = 0.0f32;
    let mut current_width = 0.0f32;

    for ch in text.chars() {
        let weight = glyph_weight(ch);
        if ch.is_whitespace() {
            push_word_span(&mut spans, &mut current, current_start, current_width);
            current_width = 0.0;
            cursor += weight;
            continue;
        }

        if current.is_empty() {
            current_start = cursor;
        }
        current.push(ch);
        current_width += weight;
        cursor += weight;
    }

    push_word_span(&mut spans, &mut current, current_start, current_width);
    (spans, cursor.max(1.0))
}

fn push_word_span(
    spans: &mut Vec<WordSpan>,
    current: &mut String,
    start_weight: f32,
    width_weight: f32,
) {
    if current.is_empty() {
        return;
    }
    spans.push(WordSpan {
        text: std::mem::take(current),
        start_weight,
        width_weight: width_weight.max(0.25),
    });
}

fn glyph_weight(ch: char) -> f32 {
    if ch.is_whitespace() {
        return 0.55;
    }
    if matches!(ch, 'i' | 'l' | 'I' | 'j' | '!' | '|' | '\'' | '`' | '1') {
        return 0.45;
    }
    if matches!(ch, 'f' | 'r' | 't' | '.' | ',' | ':' | ';') {
        return 0.6;
    }
    if matches!(ch, 'm' | 'w' | 'M' | 'W' | '@' | '%' | '&') {
        return 1.35;
    }
    if ch.is_ascii_digit() {
        return 0.9;
    }
    if ch.is_ascii_uppercase() {
        return 1.08;
    }
    if ch.is_ascii_punctuation() {
        return 0.65;
    }
    if ('\u{2E80}'..='\u{9FFF}').contains(&ch) {
        return 1.8;
    }
    1.0
}
