use serde_json::{Value, json};
use url::Url;
use url::form_urlencoded::Serializer;

use crate::proxy::USER_AGENT;

const MAX_TEXT_LEN: usize = 5_000;

pub fn translate(payload: Value) -> Result<Value, String> {
    let provider = payload
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let from = payload
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let to = payload.get("to").and_then(Value::as_str).unwrap_or("pl");
    let key = payload.get("key").and_then(Value::as_str).unwrap_or("");

    if text.is_empty() {
        return Ok(json!({ "translated": "", "engine": provider }));
    }
    if text.len() > MAX_TEXT_LEN {
        return Err("text too long".to_string());
    }

    let translated = match provider {
        "deepl" => translate_deepl(text, from, to, key)?,
        "google" => translate_google(text, from, to)?,
        "lmstudio" => translate_lmstudio(
            text,
            from,
            to,
            payload
                .get("endpoint")
                .and_then(Value::as_str)
                .unwrap_or("http://127.0.0.1:1234/v1/chat/completions"),
            payload
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("local-model"),
        )?,
        _ => return Err("unknown translation provider".to_string()),
    };

    Ok(json!({ "translated": translated, "engine": provider }))
}

fn translate_deepl(text: &str, from: &str, to: &str, key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("DeepL API key is missing".to_string());
    }

    let endpoint = if key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let mut body = Serializer::new(String::new());
    body.append_pair("text", text);
    body.append_pair("target_lang", &deepl_lang(to, true));
    if !from.is_empty() && from != "auto" {
        body.append_pair("source_lang", &deepl_lang(from, false));
    }

    let response = ureq::post(endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("DeepL-Auth-Key {key}"))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body.finish())
        .map_err(|e| e.to_string())?;
    let value: Value = response.into_json().map_err(|e| e.to_string())?;
    value
        .get("translations")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "DeepL returned no translation".to_string())
}

fn translate_google(text: &str, from: &str, to: &str) -> Result<String, String> {
    let mut query = Serializer::new(String::new());
    query.append_pair("client", "gtx");
    query.append_pair(
        "sl",
        if from.is_empty() {
            "auto"
        } else {
            google_lang(from)
        },
    );
    query.append_pair("tl", google_lang(to));
    query.append_pair("dt", "t");
    query.append_pair("q", text);
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?{}",
        query.finish()
    );

    let response = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| e.to_string())?;
    let value: Value = response.into_json().map_err(|e| e.to_string())?;
    let chunks = value
        .get(0)
        .and_then(Value::as_array)
        .ok_or_else(|| "Google Translate returned no translation".to_string())?;

    let translated = chunks
        .iter()
        .filter_map(|chunk| chunk.get(0).and_then(Value::as_str))
        .collect::<String>();
    if translated.is_empty() {
        Err("Google Translate returned no translation".to_string())
    } else {
        Ok(translated)
    }
}

fn deepl_lang(code: &str, target: bool) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" if target => "EN-US".to_string(),
        "en" => "EN".to_string(),
        "zh" if target => "ZH-HANS".to_string(),
        "zh" => "ZH".to_string(),
        "grc" => "EL".to_string(),
        other => other.to_ascii_uppercase().replace('-', "_"),
    }
}

fn google_lang(code: &str) -> &str {
    match code.trim().to_ascii_lowercase().as_str() {
        "zh" => "zh-CN",
        "grc" => "el",
        _ => code,
    }
}

fn translate_lmstudio(
    text: &str,
    from: &str,
    to: &str,
    endpoint: &str,
    model: &str,
) -> Result<String, String> {
    let parsed = Url::parse(endpoint).map_err(|e| e.to_string())?;
    if !is_local_lmstudio_url(&parsed) {
        return Err("LM Studio endpoint must be local".to_string());
    }
    let model = model.trim();
    if model.is_empty() {
        return Err("LM Studio model is missing".to_string());
    }

    let prompt =
        format!("Translate from {from} to {to}. Return only the translation, no notes.\n\n{text}");
    let payload = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a precise translation engine. Return only the translated text." },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.1,
        "max_tokens": 512,
        "stream": false
    });

    let response = ureq::post(endpoint)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| e.to_string())?;
    let value: Value = response.into_json().map_err(|e| e.to_string())?;
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(|text| text.trim().trim_matches('"').to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "LM Studio returned no translation".to_string())
}

fn is_local_lmstudio_url(url: &Url) -> bool {
    matches!(
        url.host_str().unwrap_or_default(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

#[cfg(test)]
mod tests {
    use super::{deepl_lang, google_lang, is_local_lmstudio_url};
    use url::Url;

    #[test]
    fn deepl_uses_target_specific_english_code() {
        assert_eq!(deepl_lang("en", true), "EN-US");
        assert_eq!(deepl_lang("en", false), "EN");
        assert_eq!(deepl_lang("pl", true), "PL");
        assert_eq!(deepl_lang("zh", true), "ZH-HANS");
        assert_eq!(deepl_lang("grc", false), "EL");
    }

    #[test]
    fn google_uses_provider_codes_for_new_profiles() {
        assert_eq!(google_lang("zh"), "zh-CN");
        assert_eq!(google_lang("grc"), "el");
        assert_eq!(google_lang("la"), "la");
    }

    #[test]
    fn lmstudio_endpoint_must_be_local() {
        assert!(is_local_lmstudio_url(
            &Url::parse("http://127.0.0.1:1234/v1/chat/completions").unwrap()
        ));
        assert!(is_local_lmstudio_url(
            &Url::parse("http://localhost:1234/v1/chat/completions").unwrap()
        ));
        assert!(!is_local_lmstudio_url(
            &Url::parse("https://example.com/v1/chat/completions").unwrap()
        ));
    }
}
