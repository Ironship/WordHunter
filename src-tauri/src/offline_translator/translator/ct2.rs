use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use ctranslate2::{
    ComputeType, Device, TranslationOptions, Translator2, TranslatorConfig, translator::BatchType,
};
use serde_json::{Value, json};

use super::bpe::BpeTokenizer;
use super::models::{clean_translation, find_model_dir};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Public translate endpoint — parses the query string and runs CT2 with pivot fallback.
pub fn translate(query: &str) -> Result<Value, String> {
    let params = crate::response::parse_query(query);
    let text = params
        .get("text")
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return Err("invalid request: missing text".to_string());
    }
    let from = params
        .get("from")
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    if from.is_empty() {
        return Err("invalid request: missing source language".to_string());
    }
    let to = params.get("to").map(String::as_str).unwrap_or("pl").trim();
    if to.is_empty() {
        return Err("invalid request: missing target language".to_string());
    }
    let input = json!({
        "text": text,
        "from": from,
        "to": to,
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

    let text_chars = input
        .get("text")
        .and_then(Value::as_str)
        .map_or(0, |text| text.chars().count());
    let timeout = Duration::from_millis(
        std::env::var("WH_NATIVE_CT2_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or_else(|| default_timeout_ms(text_chars)),
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

/// A long text is translated in full now, sentence by sentence, so it gets
/// more time than a word or a sentence does.
pub(crate) fn default_timeout_ms(text_chars: usize) -> u64 {
    const BASE_MS: u64 = 15_000;
    const PER_100_CHARS_MS: u64 = 1_000;
    const MAX_MS: u64 = 180_000;
    (BASE_MS + (text_chars as u64 / 100) * PER_100_CHARS_MS).min(MAX_MS)
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
        return Err(format!(
            "native CTranslate2 model was not found for {from}->{to}"
        ));
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
    let options = TranslationOptions {
        // Sentences of a long text are decoded together, up to this many tokens.
        max_batch_size: 1024,
        batch_type: BatchType::Tokens,
        beam_size: 4,
        length_penalty: 0.2,
        replace_unknowns: true,
        // Each segment is one sentence; the default cap of 256 tokens only
        // bites on very long ones.
        max_decoding_length: 512,
        ..TranslationOptions::default()
    };

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
    // Translated as one segment, a long paragraph stopped mid-text at the
    // decode limit. Translate long lines sentence by sentence and keep the
    // line structure.
    let lines = translation_segments(text);
    let sentences = lines.iter().flatten().cloned().collect::<Vec<_>>();
    if sentences.is_empty() {
        return Err("CTranslate2 returned no translation".to_string());
    }
    let mut translated = translator
        .translate_batch(&sentences, options)
        .map_err(|e| format!("CTranslate2 translation failed: {e}"))?
        .into_iter()
        .map(|(translated, _)| translated);
    let mut output = Vec::with_capacity(lines.len());
    for line in &lines {
        let parts = line
            .iter()
            .map(|_| translated.next().unwrap_or_default())
            .collect::<Vec<_>>();
        output.push(join_sentences(&parts));
    }
    Ok(output.join("\n"))
}

/// Lines up to this many characters are translated whole: that stays well
/// below the decode limit and keeps the model's context.
const MAX_UNSPLIT_LINE_CHARS: usize = 300;

/// Splits text into lines, and long lines into sentences that keep their
/// punctuation. A hard-wrapped sentence is joined back into one line first.
/// Empty lines stay (as empty lists) so the translation keeps the paragraph
/// breaks.
pub(crate) fn translation_segments(text: &str) -> Vec<Vec<String>> {
    let mut lines: Vec<String> = Vec::new();
    let mut continues = false;
    for line in text.lines().map(str::trim) {
        match lines.last_mut() {
            Some(previous) if continues && !line.is_empty() => {
                previous.push(' ');
                previous.push_str(line);
            }
            _ => lines.push(line.to_string()),
        }
        continues = !line.is_empty() && !line.ends_with(is_line_final);
    }
    lines
        .iter()
        .map(|line| {
            if line.is_empty() {
                Vec::new()
            } else if line.chars().count() <= MAX_UNSPLIT_LINE_CHARS {
                vec![line.clone()]
            } else {
                split_sentences(line)
            }
        })
        .collect()
}

/// A line ending like this ends its own line (a sentence, a verse or a
/// dialogue turn), not a hard-wrapped piece of one.
fn is_line_final(ch: char) -> bool {
    is_sentence_end(ch) || matches!(ch, ':' | ';') || is_closing(ch)
}

fn is_sentence_end(ch: char) -> bool {
    matches!(ch, '.' | '!' | '?' | '…' | '。' | '！' | '？')
}

/// Quotes and brackets that close after a sentence's final punctuation.
fn is_closing(ch: char) -> bool {
    matches!(
        ch,
        '"' | '\'' | '»' | '«' | '”' | '“' | '’' | ')' | '」' | '』' | '）'
    )
}

fn split_sentences(line: &str) -> Vec<String> {
    let chars = line.chars().collect::<Vec<_>>();
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if !is_sentence_end(ch) {
            index += 1;
            continue;
        }
        // "?!", "..." and a closing quote or bracket belong to the sentence
        // they end: 「こんにちは。」 stays one piece.
        let mut end = index;
        while chars
            .get(end + 1)
            .is_some_and(|next| is_sentence_end(*next) || is_closing(*next))
        {
            end += 1;
        }
        let ends = if matches!(ch, '。' | '！' | '？') {
            true
        } else {
            let next = chars[end + 1..].iter().find(|next| !next.is_whitespace());
            chars.get(end + 1).is_some_and(|next| next.is_whitespace())
                && next.is_some_and(|next| !next.is_lowercase())
                && (ch != '.' || !ends_with_abbreviation(&chars[start..index]))
        };
        if ends {
            let sentence = chars[start..=end].iter().collect::<String>();
            if !sentence.trim().is_empty() {
                sentences.push(sentence.trim().to_string());
            }
            start = end + 1;
        }
        index = end + 1;
    }
    let rest = chars[start..].iter().collect::<String>();
    if !rest.trim().is_empty() {
        sentences.push(rest.trim().to_string());
    }
    sentences
}

/// True when the dot after `before` more likely marks an abbreviation or an
/// ordinal ("z. B.", "Dr.", "3.") than the end of a sentence.
fn ends_with_abbreviation(before: &[char]) -> bool {
    const ABBREVIATIONS: &[&str] = &[
        "bzw", "ca", "dr", "etc", "evtl", "ggf", "inkl", "jr", "mme", "mr", "mrs", "ms", "nr",
        "prof", "sr", "sra", "st", "str", "usw", "vgl", "vs",
    ];
    let word = before
        .iter()
        .rev()
        .take_while(|ch| ch.is_alphanumeric())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_lowercase();
    !word.is_empty()
        && (word.chars().all(|ch| ch.is_ascii_digit())
            || word.chars().count() == 1
            || ABBREVIATIONS.contains(&word.as_str()))
}

/// Joins translated sentences, without spaces around Chinese or Japanese.
fn join_sentences(parts: &[String]) -> String {
    let mut joined = String::new();
    for part in parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
    {
        let no_space = joined.chars().next_back().is_some_and(is_cjk)
            || part.chars().next().is_some_and(is_cjk);
        if !joined.is_empty() && !no_space {
            joined.push(' ');
        }
        joined.push_str(part);
    }
    joined
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{3000}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{ff00}'..='\u{ffef}'
    )
}
