use serde_json::{Value, json};
use std::collections::HashMap;

const LANG_MAP: &[(&str, &str)] = &[
    ("en", "english"),
    ("de", "german"),
    ("es", "spanish"),
    ("it", "italian"),
    ("fr", "french"),
    ("pl", "polish"),
    ("ru", "russian"),
    ("uk", "ukrainian"),
    ("ja", "japanese"),
    ("zh", "chinese"),
    ("la", "latin"),
    ("grc", "greek"),
];

pub fn yg_lang_from_code(code: &str) -> &'static str {
    LANG_MAP
        .iter()
        .find(|(k, _)| *k == code)
        .map(|(_, v)| *v)
        .unwrap_or("english")
}

pub fn widget_url() -> &'static str {
    "https://youglish.com/public/emb/widget.js"
}

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    match op {
        "lang" => {
            let code = payload.get("code").and_then(Value::as_str).unwrap_or("en");
            Ok(json!({
                "code": code,
                "yg_lang": yg_lang_from_code(code),
                "widget_url": widget_url(),
            }))
        }
        "langs" => {
            let map: HashMap<&str, &str> = LANG_MAP.iter().copied().collect();
            Ok(json!({ "langs": map, "widget_url": widget_url() }))
        }
        _ => Err(format!("unknown youglish op: {op}")),
    }
}

#[cfg(test)]
#[path = "tests/youglish/tests.rs"]
mod tests;
