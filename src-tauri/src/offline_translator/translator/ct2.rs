use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use ctranslate2::{
    translator::BatchType, ComputeType, Device, TranslationOptions, Translator2, TranslatorConfig,
};
use serde_json::{json, Value};

use super::bpe::BpeTokenizer;
use super::models::{clean_translation, find_model_dir};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Public translate endpoint — parses the query string and runs CT2 with pivot fallback.
pub fn translate(query: &str) -> Result<Value, String> {
    let params = crate::response::parse_query(query);
    let input = json!({
        "text": params.get("text").cloned().unwrap_or_default(),
        "from": params.get("from").cloned().unwrap_or_default(),
        "to": params.get("to").cloned().unwrap_or_else(|| "pl".to_string()),
    });
    let translated = native_ct2_translate_with_pivot(&input)?;
    Ok(json!({ "translated": translated, "engine": "ctranslate2" }))
}

/// Worker entry point for `--ct2-translate` subprocess mode.
/// Reads JSON from stdin, translates, and prints result to stdout.
pub fn run_worker() -> i32 {
    let mut body = String::new();
    if std::io::stdin().read_to_string(&mut body).is_err() {
        return 2;
    }
    let Ok(input) = serde_json::from_str::<Value>(&body) else {
        return 2;
    };
    match native_ct2_translate_direct(&input) {
        Ok(translated) => {
            println!("{}", json!({ "translated": translated }));
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

/// Spawn a child process of ourselves with `--ct2-translate` and send it a translation job.
fn native_ct2_translate(input: &Value) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = Command::new(exe);
    command
        .arg("--ct2-translate")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let input = serde_json::to_vec(input).map_err(|e| e.to_string())?;
        // The child may exit before we finish writing (e.g. model not found). A broken
        // pipe here is not the real error — fall through to the wait loop below, which
        // reads the child's stderr and surfaces the actual failure reason.
        if let Err(write_err) = stdin.write_all(&input) {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                let output = child.wait_with_output().map_err(|e| e.to_string())?;
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if !stderr.is_empty() {
                    return Err(stderr);
                }
                if !status.success() {
                    return Err(format!("native CTranslate2 exited with {status}"));
                }
            }
            return Err(format!("failed to write CTranslate2 input: {write_err}"));
        }
    }

    let timeout = Duration::from_millis(
        std::env::var("WH_NATIVE_CT2_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(15_000),
    );
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            if status.success() {
                let value: Value = serde_json::from_slice(&output.stdout)
                    .map_err(|e| format!("native CTranslate2 returned invalid JSON: {e}"))?;
                return value
                    .get("translated")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
                    .ok_or_else(|| "native CTranslate2 returned no translation".to_string());
            }
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("native CTranslate2 exited with {status}")
            } else {
                stderr
            });
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("native CTranslate2 timed out".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Try a direct translation; if it fails, fall back to a two-step pivot via English.
fn native_ct2_translate_with_pivot(input: &Value) -> Result<String, String> {
    let text = input
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let from = input
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to = input
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or("pl")
        .to_string();

    let model_exists = find_model_dir(&from, &to).is_some();
    if model_exists {
        match native_ct2_translate(input) {
            Ok(translated) => return Ok(translated),
            Err(direct_err) => {
                if from.is_empty() || from == "en" || to == "en" {
                    return Err(direct_err);
                }
                let step1 = json!({ "text": text, "from": from, "to": "en" });
                let english = native_ct2_translate(&step1).map_err(|pivot_err| {
                    format!("{direct_err}; pivot {from}->en also failed: {pivot_err}")
                })?;
                let step2 = json!({ "text": english, "from": "en", "to": to });
                return native_ct2_translate(&step2).map_err(|pivot_err| {
                    format!("{direct_err}; pivot en->{to} also failed: {pivot_err}")
                });
            }
        }
    }

    if from.is_empty() || from == "en" || to == "en" {
        return Err(format!("native CTranslate2 model was not found for {from}->{to}"));
    }
    let step1 = json!({ "text": text, "from": from, "to": "en" });
    let english = native_ct2_translate(&step1).map_err(|pivot_err| {
        format!("direct model {from}->{to} not found; pivot {from}->en failed: {pivot_err}")
    })?;
    let step2 = json!({ "text": english, "from": "en", "to": to });
    native_ct2_translate(&step2).map_err(|pivot_err| {
        format!("direct model {from}->{to} not found; pivot en->{to} failed: {pivot_err}")
    })
}

/// Direct in-process translation using a loaded CTranslate2 model.
fn native_ct2_translate_direct(input: &Value) -> Result<String, String> {
    let text = input
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let from = input
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to = input
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or("pl")
        .to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    let model_dir = find_model_dir(&from, &to)
        .ok_or_else(|| format!("native CTranslate2 model was not found for {from}->{to}"))?;
    translate_with_ct2_model(&model_dir, &text).map(clean_translation)
}

/// Load a CT2 model and tokenizer from disk, then run translation.
fn translate_with_ct2_model(model_dir: &Path, text: &str) -> Result<String, String> {
    let ctranslate_model = model_dir.join("model");
    let mut options = TranslationOptions::default();
    options.max_batch_size = 1;
    options.batch_type = BatchType::Tokens;
    options.beam_size = 4;
    options.length_penalty = 0.2;
    options.replace_unknowns = true;

    let config = TranslatorConfig {
        device: Device::Cpu,
        compute_type: ComputeType::Default,
        num_threads_per_replica: 2,
        ..TranslatorConfig::default()
    };

    if model_dir.join("sentencepiece.model").is_file() {
        let spm = model_dir.join("sentencepiece.model");
        let tokenizer = ctranslate2::tokenizer::sentencepiece::Tokenizer::from_file(&spm, &spm)
            .map_err(|e| format!("failed to load SentencePiece tokenizer: {e}"))?;
        return translate_with_tokenizer(&ctranslate_model, tokenizer, text, options, &config);
    }
    if model_dir.join("bpe.model").is_file() {
        let tokenizer = BpeTokenizer::from_model_dir(model_dir)?;
        return translate_with_tokenizer(&ctranslate_model, tokenizer, text, options, &config);
    }

    Err("unsupported native tokenizer".to_string())
}

/// Generic translation helper that works with any `ctranslate2::Tokenizer` implementation.
fn translate_with_tokenizer<T: ctranslate2::Tokenizer>(
    model_dir: &Path,
    tokenizer: T,
    text: &str,
    options: TranslationOptions,
    config: &TranslatorConfig,
) -> Result<String, String> {
    let translator = Translator2::new(model_dir, config, tokenizer)
        .map_err(|e| format!("failed to create CTranslate2 translator: {e}"))?;
    let result = translator
        .translate_batch(&[text.to_string()], options)
        .map_err(|e| format!("CTranslate2 translation failed: {e}"))?;
    result
        .into_iter()
        .next()
        .map(|(translated, _)| translated)
        .ok_or_else(|| "CTranslate2 returned no translation".to_string())
}
