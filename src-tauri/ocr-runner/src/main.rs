use anyhow::{bail, Context, Result};
use image::{DynamicImage, ImageFormat, RgbImage};
use paddle_ocr_rs::ocr_lite::OcrLite;
use paddle_ocr_rs::ocr_result::Point;
use pdfium_render::prelude::{PdfPage, PdfRect, PdfRenderConfig, Pdfium};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use ort::execution_providers::DirectMLExecutionProvider;
#[cfg(target_os = "linux")]
use ort::execution_providers::{webgpu::WebGPUDawnBackendType, WebGPUExecutionProvider};

const ENGINE_NAME: &str = "pdfium-text-layer+paddleocr-rs-onnx";
const TEXT_LAYER_BOUNDS_VERSION: &str = "text-glyph-v2";

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
    WebGpu,
}

impl DeviceMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "cpu" => Ok(Self::Cpu),
            "directml" => Ok(Self::DirectMl),
            "webgpu" => Ok(Self::WebGpu),
            _ => bail!("invalid --device: {value} (expected auto, cpu, directml, or webgpu)"),
        }
    }
}

#[derive(Serialize)]
struct GpuStatus {
    status: &'static str,
    provider: &'static str,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds_version: Option<&'static str>,
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
    let mut ocr = None;
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

        let (lines, words, text, bounds_version) =
            match extract_pdf_text_layer(&page, page_image.width(), page_image.height())? {
                Some((lines, words, text)) => (lines, words, text, Some(TEXT_LAYER_BOUNDS_VERSION)),
                None => {
                    let ocr = ensure_ocr(&mut ocr, &models_dir, args.threads)?;
                    let (lines, words, text) = run_page_ocr(ocr, &page_image, &args)
                        .with_context(|| format!("PaddleOCR failed on PDF page {page_number}"))?;
                    (lines, words, text, None)
                }
            };
        pages.push(OcrPage {
            page: page_number,
            image_name,
            width: page_image.width(),
            height: page_image.height(),
            text,
            bounds_version,
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
        "wordhunter-paddleocr --input input.pdf --output-dir pages --json ocr.json [--lang pl] [--max-pages 0] [--device auto|cpu|directml|webgpu] (0 = all pages)\nwordhunter-paddleocr --gpu-status"
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
    use super::{
        expand_native_word_bounds, merge_native_words_using_plain_text,
        native_gap_without_space_is_word_break, native_space_is_word_break,
        native_text_layer_is_useful, page_limit, split_native_words_using_plain_text, DeviceMode,
        GpuStatus, OcrWord, PixelBounds,
    };
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
        assert_eq!(DeviceMode::parse("webgpu").unwrap(), DeviceMode::WebGpu);
        assert!(DeviceMode::parse("gpu").is_err());
    }

    #[test]
    fn serializes_gpu_status() {
        assert_eq!(
            serde_json::to_value(GpuStatus {
                status: "ready",
                provider: "webgpu"
            })
            .unwrap(),
            json!({ "status": "ready", "provider": "webgpu" })
        );
    }

    #[test]
    fn native_text_layer_requires_readable_word_boxes() {
        assert!(!native_text_layer_is_useful(&[]));
        assert!(!native_text_layer_is_useful(&[OcrWord {
            text: ".".to_string(),
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            confidence: 1.0,
        }]));
        assert!(!native_text_layer_is_useful(&[OcrWord {
            text: "PDF".to_string(),
            x: 0.0,
            y: 0.0,
            width: 12.0,
            height: 8.0,
            confidence: 1.0,
        }]));
        assert!(native_text_layer_is_useful(&[OcrWord {
            text: "This page has a readable native text layer.".to_string(),
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 12.0,
            confidence: 1.0,
        }]));
    }

    #[test]
    fn native_word_bounds_keep_vertical_position_on_pdf_text() {
        let bounds = expand_native_word_bounds(
            PixelBounds {
                left: 10.0,
                top: 20.0,
                right: 50.0,
                bottom: 40.0,
            },
            100,
            100,
        );

        assert!(bounds.left < 10.0);
        assert_eq!(bounds.top, 20.0);
        assert!(bounds.right > 50.0);
        assert_eq!(bounds.bottom, 40.0);
        assert!(bounds.bottom <= 100.0);
    }

    #[test]
    fn native_text_layer_merges_tiny_pdf_spaces_inside_words() {
        let previous = PixelBounds {
            left: 10.0,
            top: 20.0,
            right: 40.0,
            bottom: 30.0,
        };
        let next = PixelBounds {
            left: 40.8,
            top: 20.0,
            right: 82.0,
            bottom: 30.0,
        };

        assert!(!native_space_is_word_break(
            "Welt", previous, 'm', next, false
        ));
    }

    #[test]
    fn native_text_layer_merges_short_false_space_after_initial_letter() {
        let words = vec![
            test_word("W", 10.0, 20.0, 8.0, 10.0),
            test_word("eltmeisterschaftsstatus", 21.0, 20.0, 61.0, 10.0),
        ];
        let merged =
            merge_native_words_using_plain_text(words, "Rennen ohne Weltmeisterschaftsstatus");

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "Weltmeisterschaftsstatus");
    }

    #[test]
    fn native_text_layer_keeps_spaces_after_numbers() {
        let words = vec![
            test_word("1", 10.0, 20.0, 8.0, 10.0),
            test_word("Weltmeisterschaft", 21.0, 20.0, 61.0, 10.0),
        ];
        let merged = merge_native_words_using_plain_text(words, "1 Weltmeisterschaft");

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].text, "1");
        assert_eq!(merged[1].text, "Weltmeisterschaft");
    }

    #[test]
    fn native_text_layer_keeps_normal_words_when_plain_text_lacks_spaces() {
        let words = vec![
            test_word("mindestens", 10.0, 20.0, 70.0, 10.0),
            test_word("zwei", 84.0, 20.0, 24.0, 10.0),
            test_word("stunden", 112.0, 20.0, 42.0, 10.0),
        ];
        let merged = merge_native_words_using_plain_text(words, "mindestenszweistunden");

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].text, "mindestens");
        assert_eq!(merged[1].text, "zwei");
        assert_eq!(merged[2].text, "stunden");
    }

    #[test]
    fn native_text_layer_splits_joined_words_using_plain_text() {
        let words = vec![test_word(
            "Konstrukteursweltmeisterschaftwerden",
            10.0,
            20.0,
            160.0,
            10.0,
        )];
        let split = split_native_words_using_plain_text(
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
    fn native_text_layer_keeps_hyphenated_compound_from_plain_text() {
        let words = vec![test_word(
            "Automobil-Weltmeisterschaft",
            10.0,
            20.0,
            120.0,
            10.0,
        )];
        let split = split_native_words_using_plain_text(
            words,
            "Die Formel-1-Weltmeisterschaft (bis 1980 Automobil-Weltmeisterschaft) wird",
        );

        assert_eq!(split.len(), 1);
        assert_eq!(split[0].text, "Automobil-Weltmeisterschaft");
    }

    #[test]
    fn native_text_layer_recovers_alignment_after_wide_chart_token() {
        let words = vec![
            test_word("0123456789012345", 10.0, 20.0, 160.0, 10.0),
            test_word("DieReifengehören", 10.0, 40.0, 120.0, 10.0),
        ];
        let split = split_native_words_using_plain_text(
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
    fn native_text_layer_keeps_real_spaces_and_line_breaks() {
        let previous = PixelBounds {
            left: 10.0,
            top: 20.0,
            right: 40.0,
            bottom: 30.0,
        };
        let same_line_next = PixelBounds {
            left: 42.0,
            top: 20.0,
            right: 78.0,
            bottom: 30.0,
        };
        let next_line = PixelBounds {
            left: 10.0,
            top: 34.0,
            right: 44.0,
            bottom: 44.0,
        };

        assert!(native_space_is_word_break(
            "FIA",
            previous,
            'F',
            same_line_next,
            false
        ));
        assert!(native_space_is_word_break(
            "Welt", previous, 'm', next_line, true
        ));
    }

    #[test]
    fn native_text_layer_splits_missing_space_on_large_visual_gap() {
        let previous = PixelBounds {
            left: 10.0,
            top: 20.0,
            right: 40.0,
            bottom: 30.0,
        };
        let next = PixelBounds {
            left: 48.0,
            top: 20.0,
            right: 84.0,
            bottom: 30.0,
        };

        assert!(native_gap_without_space_is_word_break(
            "FIA", previous, 'F', next
        ));
    }

    #[test]
    fn native_text_layer_splits_missing_space_on_normal_visual_gap() {
        let previous = PixelBounds {
            left: 10.0,
            top: 20.0,
            right: 80.0,
            bottom: 30.0,
        };
        let next = PixelBounds {
            left: 84.0,
            top: 20.0,
            right: 108.0,
            bottom: 30.0,
        };

        assert!(native_gap_without_space_is_word_break(
            "mindestens",
            previous,
            'z',
            next
        ));
    }

    fn test_word(text: &str, x: f32, y: f32, width: f32, height: f32) -> OcrWord {
        OcrWord {
            text: text.to_string(),
            x,
            y,
            width,
            height,
            confidence: 1.0,
        }
    }
}

fn configure_ort(device: DeviceMode) -> Result<()> {
    let _ = match device {
        DeviceMode::Auto => {
            #[cfg(windows)]
            {
                ort::init()
                    .with_execution_providers([DirectMLExecutionProvider::default()
                        .build()
                        .fail_silently()])
                    .commit()?
            }
            #[cfg(target_os = "linux")]
            {
                ort::init()
                    .with_execution_providers([WebGPUExecutionProvider::default()
                        .with_dawn_backend_type(WebGPUDawnBackendType::Vulkan)
                        .build()
                        .fail_silently()])
                    .commit()?
            }
            #[cfg(not(any(windows, target_os = "linux")))]
            {
                ort::init().commit()?
            }
        }
        DeviceMode::Cpu => ort::init().commit()?,
        DeviceMode::DirectMl => {
            #[cfg(windows)]
            {
                ort::init()
                    .with_execution_providers([DirectMLExecutionProvider::default()
                        .build()
                        .error_on_failure()])
                    .commit()?
            }
            #[cfg(not(windows))]
            {
                bail!("DirectML is not available on this platform")
            }
        }
        DeviceMode::WebGpu => {
            #[cfg(target_os = "linux")]
            {
                ort::init()
                    .with_execution_providers([WebGPUExecutionProvider::default()
                        .with_dawn_backend_type(WebGPUDawnBackendType::Vulkan)
                        .build()
                        .error_on_failure()])
                    .commit()?
            }
            #[cfg(not(target_os = "linux"))]
            {
                bail!("WebGPU is not available on this platform")
            }
        }
    };
    Ok(())
}

fn write_gpu_status(args: &Args) -> Result<()> {
    #[cfg(windows)]
    let (device, provider) = (DeviceMode::DirectMl, "directml");
    #[cfg(target_os = "linux")]
    let (device, provider) = (DeviceMode::WebGpu, "webgpu");
    #[cfg(not(any(windows, target_os = "linux")))]
    return print_gpu_status("unavailable", "cpu");

    let models_dir = args
        .models_dir
        .clone()
        .unwrap_or(runtime_root()?.join("models"));
    let ready = configure_ort(device)
        .and_then(|_| load_ocr(&models_dir, args.threads).map(|_| ()))
        .is_ok();
    print_gpu_status(
        if ready { "ready" } else { "unavailable" },
        if ready { provider } else { "cpu" },
    )?;
    Ok(())
}

fn print_gpu_status(status: &'static str, provider: &'static str) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string(&GpuStatus { status, provider })
            .context("failed to serialize GPU status")?
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

fn ensure_ocr<'a>(
    ocr: &'a mut Option<OcrLite>,
    models_dir: &Path,
    threads: usize,
) -> Result<&'a mut OcrLite> {
    if ocr.is_none() {
        *ocr = Some(load_ocr(models_dir, threads)?);
    }
    Ok(ocr.as_mut().expect("OCR was initialized"))
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

type ExtractedTextLayer = (Vec<OcrLine>, Vec<OcrWord>, String);

fn extract_pdf_text_layer(
    page: &PdfPage<'_>,
    image_width: u32,
    image_height: u32,
) -> Result<Option<ExtractedTextLayer>> {
    let page_text = match page.text() {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    let page_width = page.width().value.max(1.0);
    let page_height = page.height().value.max(1.0);

    let mut words = Vec::new();
    let mut current = String::new();
    let mut current_bounds = None;
    let mut last_char_bounds = None;
    let mut pending_space = None;

    for text_char in page_text.chars().iter() {
        let Some(ch) = text_char.unicode_char() else {
            continue;
        };
        if ch == '\0' || (ch.is_control() && !ch.is_whitespace()) {
            continue;
        }
        let char_bounds = text_char
            .loose_bounds()
            .or_else(|_| text_char.tight_bounds())
            .ok()
            .and_then(|bounds| {
                pdf_rect_to_pixels(bounds, page_width, page_height, image_width, image_height)
            });

        if ch.is_whitespace() {
            if !current.is_empty() {
                pending_space = Some(PendingNativeSpace {
                    hard_break: pending_space
                        .map(|space: PendingNativeSpace| space.hard_break)
                        .unwrap_or(false)
                        || native_whitespace_is_hard_break(ch),
                });
            }
            continue;
        }

        let Some(char_bounds) = char_bounds else {
            continue;
        };

        if let Some(previous_bounds) = last_char_bounds {
            let should_break = pending_space
                .map(|space| {
                    native_space_is_word_break(
                        &current,
                        previous_bounds,
                        ch,
                        char_bounds,
                        space.hard_break,
                    )
                })
                .unwrap_or_else(|| {
                    native_gap_without_space_is_word_break(
                        &current,
                        previous_bounds,
                        ch,
                        char_bounds,
                    )
                });
            if should_break {
                flush_native_word(
                    &mut words,
                    &mut current,
                    &mut current_bounds,
                    image_width,
                    image_height,
                );
            }
        }
        pending_space = None;

        current_bounds = Some(match current_bounds {
            Some(bounds) => bounds.union(char_bounds),
            None => char_bounds,
        });
        current.push(ch);
        last_char_bounds = Some(char_bounds);
    }

    flush_native_word(
        &mut words,
        &mut current,
        &mut current_bounds,
        image_width,
        image_height,
    );
    let plain_text = page_text.all();
    let words = split_native_words_using_plain_text(
        merge_native_words_using_plain_text(words, &plain_text),
        &plain_text,
    );

    if !native_text_layer_is_useful(&words) {
        return Ok(None);
    }

    let text =
        clean_native_plain_page_text(&plain_text).unwrap_or_else(|| native_text_from_words(&words));
    let lines = words.iter().map(native_word_to_line).collect();
    Ok(Some((lines, words, text)))
}

#[derive(Clone, Copy, Debug)]
struct PendingNativeSpace {
    hard_break: bool,
}

#[derive(Clone, Copy, Debug)]
struct PixelBounds {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl PixelBounds {
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

fn native_whitespace_is_hard_break(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{000C}' | '\u{2028}' | '\u{2029}')
}

fn native_space_is_word_break(
    current: &str,
    previous: PixelBounds,
    next_char: char,
    next: PixelBounds,
    hard_break: bool,
) -> bool {
    if hard_break || native_bounds_are_on_different_lines(previous, next) {
        return true;
    }

    let gap = native_horizontal_gap(previous, next);
    if gap <= native_false_space_gap(previous, next)
        && native_chars_can_merge_across_pdf_space(current, next_char)
    {
        return false;
    }

    true
}

fn native_gap_without_space_is_word_break(
    current: &str,
    previous: PixelBounds,
    next_char: char,
    next: PixelBounds,
) -> bool {
    if native_bounds_are_on_different_lines(previous, next) {
        return true;
    }

    let gap = native_horizontal_gap(previous, next);
    gap > native_missing_space_gap(previous, next)
        && native_chars_can_break_on_visual_gap(current, next_char)
}

fn native_bounds_are_on_different_lines(previous: PixelBounds, next: PixelBounds) -> bool {
    let overlap = (previous.bottom.min(next.bottom) - previous.top.max(next.top)).max(0.0);
    let min_height = previous.height().min(next.height()).max(1.0);
    let top_delta = (next.top - previous.top).abs();
    overlap / min_height < 0.45 && top_delta > min_height * 0.55
}

fn native_horizontal_gap(previous: PixelBounds, next: PixelBounds) -> f32 {
    (next.left - previous.right).max(0.0)
}

fn native_false_space_gap(previous: PixelBounds, next: PixelBounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.16
}

fn native_missing_space_gap(previous: PixelBounds, next: PixelBounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.28
}

fn native_chars_can_merge_across_pdf_space(current: &str, next_char: char) -> bool {
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    if !native_char_can_join_word(previous_char) || !native_char_can_join_word(next_char) {
        return false;
    }
    if native_token_looks_like_acronym(current) && next_char.is_uppercase() {
        return false;
    }
    previous_char.is_alphabetic() && next_char.is_alphabetic()
        || previous_char.is_lowercase()
        || next_char.is_lowercase()
}

fn native_chars_can_break_on_visual_gap(current: &str, next_char: char) -> bool {
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    if previous_char == '-' || previous_char == '\u{2010}' || previous_char == '\u{2011}' {
        return false;
    }
    native_char_can_join_word(previous_char) && native_char_can_join_word(next_char)
}

fn native_char_can_join_word(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '\'' | '\u{2019}' | '-')
}

fn native_token_looks_like_acronym(text: &str) -> bool {
    let mut letters = 0usize;
    for ch in text.chars() {
        if !ch.is_alphabetic() {
            continue;
        }
        letters += 1;
        if !ch.is_uppercase() {
            return false;
        }
    }
    (2..=5).contains(&letters)
}

fn pdf_rect_to_pixels(
    rect: PdfRect,
    page_width: f32,
    page_height: f32,
    image_width: u32,
    image_height: u32,
) -> Option<PixelBounds> {
    let left = rect
        .left()
        .value
        .min(rect.right().value)
        .clamp(0.0, page_width);
    let right = rect
        .left()
        .value
        .max(rect.right().value)
        .clamp(0.0, page_width);
    let bottom = rect
        .bottom()
        .value
        .min(rect.top().value)
        .clamp(0.0, page_height);
    let top = rect
        .bottom()
        .value
        .max(rect.top().value)
        .clamp(0.0, page_height);

    if right <= left || top <= bottom {
        return None;
    }

    let image_width = image_width as f32;
    let image_height = image_height as f32;
    let pixel_bounds = PixelBounds {
        left: left / page_width * image_width,
        top: (page_height - top) / page_height * image_height,
        right: right / page_width * image_width,
        bottom: (page_height - bottom) / page_height * image_height,
    };

    if pixel_bounds.left.is_finite()
        && pixel_bounds.top.is_finite()
        && pixel_bounds.right.is_finite()
        && pixel_bounds.bottom.is_finite()
    {
        Some(pixel_bounds)
    } else {
        None
    }
}

fn flush_native_word(
    words: &mut Vec<OcrWord>,
    current: &mut String,
    current_bounds: &mut Option<PixelBounds>,
    image_width: u32,
    image_height: u32,
) {
    let text = current.trim().to_string();
    current.clear();
    let Some(bounds) = current_bounds.take() else {
        return;
    };
    if text.is_empty() {
        return;
    }

    let bounds = expand_native_word_bounds(bounds, image_width, image_height);
    words.push(OcrWord {
        text,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width(),
        height: bounds.height(),
        confidence: 1.0,
    });
}

fn expand_native_word_bounds(
    bounds: PixelBounds,
    image_width: u32,
    image_height: u32,
) -> PixelBounds {
    let side_room = (bounds.width() * 0.015).clamp(0.5, 3.0);
    PixelBounds {
        left: (bounds.left - side_room).max(0.0),
        top: bounds.top.max(0.0),
        right: (bounds.right + side_room).min(image_width as f32),
        bottom: bounds.bottom.min(image_height as f32),
    }
}

fn merge_native_words_using_plain_text(words: Vec<OcrWord>, plain_text: &str) -> Vec<OcrWord> {
    let lookup_text = normalize_pdf_text_for_lookup(plain_text);
    if lookup_text.is_empty() || words.len() < 2 {
        return words;
    }

    let mut merged: Vec<OcrWord> = Vec::with_capacity(words.len());
    for word in words {
        if let Some(previous) = merged.last_mut() {
            let previous_bounds = native_word_bounds(previous);
            let word_bounds = native_word_bounds(&word);
            if native_words_same_line(previous, &word)
                && should_merge_words_from_plain_text(
                    &previous.text,
                    &word.text,
                    previous_bounds,
                    word_bounds,
                    &lookup_text,
                )
            {
                merge_native_words(previous, &word);
                continue;
            }
        }
        merged.push(word);
    }
    merged
}

fn split_native_words_using_plain_text(words: Vec<OcrWord>, plain_text: &str) -> Vec<OcrWord> {
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
            split.extend(split_native_word_by_plain_parts(word, &parts));
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

fn split_native_word_by_plain_parts(word: OcrWord, parts: &[String]) -> Vec<OcrWord> {
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
        output.push(OcrWord {
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

fn native_words_same_line(previous: &OcrWord, next: &OcrWord) -> bool {
    !native_bounds_are_on_different_lines(native_word_bounds(previous), native_word_bounds(next))
}

fn should_merge_words_from_plain_text(
    left: &str,
    right: &str,
    previous: PixelBounds,
    next: PixelBounds,
    lookup_text: &str,
) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() || !word_text_can_merge(left, right) {
        return false;
    }
    if !plain_text_word_fragment_can_merge(left, right, native_pdf_fragment_gap(previous, next)) {
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

fn native_pdf_fragment_gap(previous: PixelBounds, next: PixelBounds) -> bool {
    native_horizontal_gap(previous, next)
        <= previous.height().min(next.height()).clamp(1.0, 48.0) * 0.35
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

fn merge_native_words(left: &mut OcrWord, right: &OcrWord) {
    let bounds = native_word_bounds(left).union(native_word_bounds(right));
    left.text.push_str(&right.text);
    left.x = bounds.left;
    left.y = bounds.top;
    left.width = bounds.width();
    left.height = bounds.height();
    left.confidence = left.confidence.min(right.confidence);
}

fn native_word_bounds(word: &OcrWord) -> PixelBounds {
    PixelBounds {
        left: word.x,
        top: word.y,
        right: word.x + word.width,
        bottom: word.y + word.height,
    }
}

fn normalize_pdf_text_for_lookup(text: &str) -> String {
    let cleaned = text
        .chars()
        .filter(|ch| !matches!(ch, '\u{00ad}' | '\u{200b}'))
        .collect::<String>();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_native_plain_page_text(text: &str) -> Option<String> {
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

fn native_text_layer_is_useful(words: &[OcrWord]) -> bool {
    let readable_chars = words
        .iter()
        .flat_map(|word| word.text.chars())
        .filter(|ch| ch.is_alphanumeric())
        .count();
    !words.is_empty() && readable_chars >= 20
}

fn native_text_from_words(words: &[OcrWord]) -> String {
    words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn native_word_to_line(word: &OcrWord) -> OcrLine {
    OcrLine {
        text: word.text.clone(),
        x: word.x,
        y: word.y,
        width: word.width,
        height: word.height,
        confidence: word.confidence,
    }
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
