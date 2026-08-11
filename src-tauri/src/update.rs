use regex::Regex;
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const LATEST_STABLE_RELEASE_URL: &str =
    "https://api.github.com/repos/Ironship/WordHunter/releases/latest";

static CHECK_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

#[cfg(not(test))]
const CHECK_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

#[cfg(test)]
const CHECK_CACHE_TTL: Duration = Duration::from_millis(100);

pub fn display_version(version: &str) -> String {
    version.replace('+', ".")
}

/// Runs `fetch` unless a successful result was cached within `CHECK_CACHE_TTL`.
/// Failures are never cached, so a transient network problem is retried on
/// the next call instead of being served stale for an hour.
fn check_with(
    cache: &Mutex<Option<(Instant, Value)>>,
    user_agent: &str,
    app_version: &str,
    fetch: impl Fn(&str, &str) -> Value,
) -> Value {
    {
        let guard = cache.lock().unwrap();
        if let Some((cached_at, cached)) = guard.as_ref()
            && cached_at.elapsed() < CHECK_CACHE_TTL
        {
            return cached.clone();
        }
    }
    let result = fetch(user_agent, app_version);
    if result.get("error").is_none() {
        let mut guard = cache.lock().unwrap();
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

pub fn check(user_agent: &str, app_version: &str) -> Value {
    check_with(
        &CHECK_CACHE,
        user_agent,
        app_version,
        |user_agent, app_version| {
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
        },
    )
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

#[cfg(test)]
#[path = "tests/update/tests.rs"]
mod tests;
