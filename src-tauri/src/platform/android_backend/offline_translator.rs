use serde_json::{json, Value};

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

pub fn popup_html(_query: &str, _template: &[u8]) -> Result<Vec<u8>, String> {
    Err("Offline translator popup is desktop-only in Word Hunter Pocket".to_string())
}

pub fn install(_payload: Value) -> Result<Value, String> {
    Err("Offline model install is desktop-only in Word Hunter Pocket".to_string())
}
