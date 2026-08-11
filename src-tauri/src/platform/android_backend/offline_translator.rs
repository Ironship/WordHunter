use serde_json::{Value, json};

pub fn run_worker() -> i32 {
    eprintln!("CTranslate2 worker is desktop-only");
    1
}

pub fn status() -> Value {
    json!({
        "available": false,
        "native": false,
        "models": [],
        "reason": "CTranslate2 is desktop-only in Word Hunter Pocket"
    })
}

pub fn packages() -> Result<Value, String> {
    Ok(json!({ "packages": [] }))
}

pub fn translate(_query: &str) -> Result<Value, String> {
    Err("Offline CTranslate2 is desktop-only in Word Hunter Pocket".to_string())
}

pub fn popup_html(query: &str, _template: &[u8]) -> Result<Vec<u8>, String> {
    let requested_locale = crate::response::parse_query(query)
        .get("locale")
        .cloned()
        .unwrap_or_else(|| "en".to_string());
    let locale = if ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja", "zh"]
        .contains(&requested_locale.as_str())
    {
        requested_locale.as_str()
    } else {
        "en"
    };
    let message = crate::router::WEB_ASSETS
        .get_file(format!("i18n/{locale}.json"))
        .and_then(|file| serde_json::from_slice::<Value>(file.contents()).ok())
        .and_then(|value| {
            value
                .pointer("/translator/providerUnavailable")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Translation engine unavailable".to_string());
    Err(message)
}

pub fn install(_payload: Value) -> Result<Value, String> {
    Err("Offline model install is desktop-only in Word Hunter Pocket".to_string())
}
