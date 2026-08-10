use super::*;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

#[test]
fn check_results_are_cached_within_the_ttl() {
    let cache: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    let first = check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "latest": "1.0.9", "current": "1.0.8" })
    });
    let second = check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "latest": "1.0.9", "current": "1.0.8" })
    });
    assert_eq!(first, second);
    assert_eq!(
        calls.load(Ordering::Relaxed),
        1,
        "the second call must be served from the cache"
    );
}

#[test]
fn check_refetches_after_the_ttl_expires() {
    let cache: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "latest": "1.0.9", "current": "1.0.8" })
    });
    std::thread::sleep(CHECK_CACHE_TTL * 2);
    check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "latest": "1.0.9", "current": "1.0.8" })
    });
    assert_eq!(
        calls.load(Ordering::Relaxed),
        2,
        "expired cache entries must refetch"
    );
}

#[test]
fn check_does_not_cache_errors() {
    let cache: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "error": "network unavailable", "current": "1.0.8" })
    });
    check_with(&cache, "test-agent", "1.0.8", |_, _| {
        calls.fetch_add(1, Ordering::Relaxed);
        json!({ "error": "network unavailable", "current": "1.0.8" })
    });
    assert_eq!(
        calls.load(Ordering::Relaxed),
        2,
        "errors must not be cached"
    );
}

#[test]
fn normalizes_release_tags() {
    assert_eq!(normalize_release_version("v0.2.7.6"), "0.2.7.6");
    assert_eq!(normalize_release_version("release-1.2.3"), "1.2.3");
    assert_eq!(
        normalize_release_version("WordHunter1.0.5-rc.1"),
        "1.0.5-rc.1"
    );
    assert_eq!(normalize_release_version("nightly"), "nightly");
}

#[test]
fn presents_semver_hotfix_metadata_as_the_public_four_part_version() {
    assert_eq!(display_version("1.0.7+1"), "1.0.7.1");
    assert_eq!(display_version("1.0.8-rc.1"), "1.0.8-rc.1");
}

#[test]
fn parses_version_into_components() {
    assert_eq!(parse_version("0.2.7.6"), vec![0u32, 2, 7, 6]);
    assert_eq!(parse_version("v1.2.3"), vec![1u32, 2, 3]);
    assert_eq!(parse_version(""), Vec::<u32>::new());
    assert_eq!(parse_version("no-digits"), Vec::<u32>::new());
    assert_eq!(parse_version("0"), vec![0u32]);
}

#[test]
fn compares_versions() {
    assert!(is_newer("0.2.7.7", "0.2.7.6"));
    assert!(is_newer("1.0.0", "0.99.99"));
    assert!(is_newer("0.2.8", "0.2.7.6"));
    assert!(!is_newer("0.2.7.6", "0.2.7.6"));
    assert!(!is_newer("0.2.7.5", "0.2.7.6"));
    assert!(!is_newer("0.2", "0.2.0"));
    assert!(is_newer("0.2.1", "0.2"));
    assert!(
        is_newer("0.3", "0.2.99"),
        "shorter version can be newer than longer base"
    );
    assert!(
        !is_newer("0.2.99", "0.3"),
        "longer base with smaller trailing must lose to shorter head"
    );
    assert!(is_newer("1.0.5-rc.2", "1.0.5-rc.1"));
    assert!(is_newer("1.0.5", "1.0.5-rc.2"));
    assert!(!is_newer("1.0.5-rc.1", "1.0.5"));
    assert!(!is_newer("1.0.5-rc.1", "1.0.5-rc.1"));
}

#[test]
fn checks_only_the_latest_stable_github_release() {
    assert!(LATEST_STABLE_RELEASE_URL.ends_with("/releases/latest"));
    assert!(!LATEST_STABLE_RELEASE_URL.contains("per_page"));
}

#[test]
fn handle_rejects_unknown_op() {
    assert!(handle(json!({ "op": "nope" })).is_err());
}
