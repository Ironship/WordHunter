use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

use super::package::package_roots;

/// List available native CT2 models as (from, to, tokenizer) tuples.
fn native_ct2_models() -> Vec<(String, String, String)> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for root in package_roots() {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some((from, to)) = read_model_pair(&dir) else {
                continue;
            };
            let tokenizer = if dir.join("sentencepiece.model").is_file() {
                "sentencepiece"
            } else if dir.join("bpe.model").is_file() {
                "bpe"
            } else {
                continue;
            };
            if dir.join("model").join("model.bin").is_file() {
                let key = format!("{from}:{to}");
                if seen.insert(key) {
                    models.push((from, to, tokenizer.to_string()));
                }
            }
        }
    }
    models
}

/// Find the model directory for a given language pair.
pub(crate) fn find_model_dir(from: &str, to: &str) -> Option<PathBuf> {
    for root in package_roots() {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let dir = entry.path();
            if !dir.is_dir() || !dir.join("model").join("model.bin").is_file() {
                continue;
            }
            if let Some((model_from, model_to)) = read_model_pair(&dir) {
                if model_from == from && model_to == to {
                    return Some(dir);
                }
            }
        }
    }
    None
}

/// Read the `from_code` / `to_code` from a model's metadata.json.
fn read_model_pair(dir: &Path) -> Option<(String, String)> {
    let metadata = fs::read_to_string(dir.join("metadata.json")).ok()?;
    let value = serde_json::from_str::<Value>(&metadata).ok()?;
    Some((
        value.get("from_code")?.as_str()?.to_string(),
        value.get("to_code")?.as_str()?.to_string(),
    ))
}

/// Public status endpoint — returns available models.
pub fn status() -> Value {
    let models = native_ct2_models()
        .into_iter()
        .map(|(from, to, tokenizer)| {
            json!({ "from": from, "to": to, "engine": "ctranslate2", "tokenizer": tokenizer })
        })
        .collect::<Vec<_>>();
    json!({
        "available": !models.is_empty(),
        "native": true,
        "models": models,
    })
}

/// Public packages endpoint — fetches the Argos package index.
pub fn packages() -> Result<Value, String> {
    let packages = super::package::fetch_package_index()?
        .into_iter()
        .filter(|pkg| pkg.package_type == "translate")
        .map(|pkg| {
            json!({
                "from": pkg.from_code,
                "to": pkg.to_code,
                "size_mb": 150,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "packages": packages }))
}

/// Clean up raw translation output by removing BPE artifacts and normalising spaces.
pub(crate) fn clean_translation(value: String) -> String {
    let mut cleaned = value
        .replace("\\n", "\n")
        .replace("\\t", " ")
        .replace('▁', " ")
        .replace("<unk>", "");
    let patterns = [
        r"\{[A-Z]:\s*[^\{\}]{0,120}\}",
        r"\{\s*\d+\s*\}",
        r"\{\s*[A-Za-z0-9_$:;.,#@/\- ]{1,80}\s*\}",
        r"^\s*[/\\|]+\s*",
    ];
    for pattern in patterns {
        let compiled = Regex::new(pattern);
        if let Ok(regex) = compiled {
            cleaned = regex.replace_all(&cleaned, "").to_string();
        }
    }
    for (pattern, replacement) in [(r"\s+([,.;:!?])", "$1"), (r"\s+'", "'"), (r"\s+", " ")] {
        let compiled = Regex::new(pattern);
        if let Ok(regex) = compiled {
            cleaned = regex.replace_all(&cleaned, replacement).to_string();
        }
    }
    cleaned.trim().to_string()
}
