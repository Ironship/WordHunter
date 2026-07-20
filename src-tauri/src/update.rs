use regex::Regex;
use serde_json::{Value, json};

pub const LATEST_STABLE_RELEASE_URL: &str =
    "https://api.github.com/repos/Ironship/WordHunter/releases/latest";

pub fn display_version(version: &str) -> String {
    version.replace('+', ".")
}

pub fn check(user_agent: &str, app_version: &str) -> Value {
    let display_version = display_version(app_version);
    match crate::http::agent()
        // GitHub's latest endpoint intentionally excludes drafts and prereleases.
        .get(LATEST_STABLE_RELEASE_URL)
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
                json!({ "latest": normalize_release_version(&latest), "current": display_version })
            }
            Err(err) => json!({ "error": err.to_string(), "current": display_version }),
        },
        Err(err) => json!({ "error": err.to_string(), "current": display_version }),
    }
}

pub fn normalize_release_version(tag: &str) -> String {
    let trimmed = tag.trim().trim_start_matches(['v', 'V']);
    match Regex::new(r"\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?") {
        Ok(regex) => regex
            .find(trimmed)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| trimmed.to_string()),
        Err(_) => trimmed.to_string(),
    }
}

fn split_version(version: &str) -> (Vec<u32>, Option<Vec<&str>>) {
    let normalized = version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('+')
        .next()
        .unwrap_or("");
    let (core, prerelease) = normalized
        .split_once('-')
        .map_or((normalized, None), |(core, prerelease)| {
            (core, Some(prerelease.split('.').collect()))
        });
    (parse_version(core), prerelease)
}

fn compare_prerelease(a: &[&str], b: &[&str]) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    for index in 0..a.len().max(b.len()) {
        let Some(left) = a.get(index) else {
            return Ordering::Less;
        };
        let Some(right) = b.get(index) else {
            return Ordering::Greater;
        };
        let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
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
    use std::cmp::Ordering;

    let (a, a_prerelease) = split_version(latest);
    let (b, b_prerelease) = split_version(current);
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
    match (a_prerelease, b_prerelease) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => compare_prerelease(&a, &b) == Ordering::Greater,
        (None, None) => false,
    }
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
