use regex::Regex;
use serde_json::{Value, json};

pub fn check(user_agent: &str, app_version: &str) -> Value {
    match crate::http::agent()
        .get("https://api.github.com/repos/Ironship/WordHunter/releases/latest")
        .set("User-Agent", user_agent)
        .set("Accept", "application/vnd.github.v3+json")
        .call()
    {
        Ok(response) => match response.into_json::<Value>() {
            Ok(data) => {
                let latest = data
                    .get("tag_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                json!({ "latest": normalize_release_version(&latest), "current": app_version })
            }
            Err(err) => json!({ "error": err.to_string(), "current": app_version }),
        },
        Err(err) => json!({ "error": err.to_string(), "current": app_version }),
    }
}

pub fn normalize_release_version(tag: &str) -> String {
    let trimmed = tag.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    match Regex::new(r"\d+(?:\.\d+){1,3}") {
        Ok(regex) => regex
            .find(trimmed)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| trimmed.to_string()),
        Err(_) => trimmed.to_string(),
    }
}

pub fn parse_version(version: &str) -> Vec<u32> {
    Regex::new(r"\d+")
        .ok()
        .map(|re| {
            re.find_iter(version)
                .filter_map(|m| m.as_str().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let a = parse_version(latest);
    let b = parse_version(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let an = a.get(i).copied().unwrap_or(0);
        let bn = b.get(i).copied().unwrap_or(0);
        if an > bn {
            return true;
        }
        if an < bn {
            return false;
        }
    }
    false
}

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    match op {
        "parse_version" => {
            let v = payload.get("version").and_then(Value::as_str).unwrap_or("");
            Ok(json!({ "version": v, "parts": parse_version(v) }))
        }
        "is_newer" => {
            let latest = payload.get("latest").and_then(Value::as_str).unwrap_or("");
            let current = payload.get("current").and_then(Value::as_str).unwrap_or("");
            Ok(json!({
                "latest": latest,
                "current": current,
                "is_newer": is_newer(latest, current),
            }))
        }
        _ => Err(format!("unknown update op: {op}")),
    }
}

#[cfg(test)]
#[path = "tests/update/tests.rs"]
mod tests;
