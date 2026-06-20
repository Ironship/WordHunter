use super::*;

#[test]
fn normalizes_release_tags() {
    assert_eq!(normalize_release_version("v0.2.7.6"), "0.2.7.6");
    assert_eq!(normalize_release_version("release-1.2.3"), "1.2.3");
    assert_eq!(normalize_release_version("nightly"), "nightly");
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
    assert!(is_newer("0.3", "0.2.99"), "shorter version can be newer than longer base");
    assert!(!is_newer("0.2.99", "0.3"), "longer base with smaller trailing must lose to shorter head");
}

#[test]
fn handle_rejects_unknown_op() {
    assert!(handle(json!({ "op": "nope" })).is_err());
}
