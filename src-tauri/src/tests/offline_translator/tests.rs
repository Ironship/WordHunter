use super::translator::models::clean_translation;
use super::translator::ui::translator_labels;

#[test]
fn clean_translation_strips_artifacts_and_normalizes_spaces() {
    assert_eq!(
        clean_translation("▁Hello  ,  world <unk> {A: junk}".to_string()),
        "Hello, world"
    );
    assert_eq!(clean_translation("▁▁plain▁▁".to_string()), "plain");
    assert_eq!(
        clean_translation("no artifacts here".to_string()),
        "no artifacts here"
    );
    assert_eq!(
        clean_translation("   leading and trailing   ".to_string()),
        "leading and trailing"
    );
    assert_eq!(clean_translation("{A:x} {B:y} {C:z}".to_string()), "");
}

#[test]
fn default_labels_use_neutral_translator_name() {
    let labels = translator_labels("en");
    for (key, value) in &labels {
        assert!(
            !value.contains("Argos"),
            "label {key}={value:?} still mentions Argos"
        );
    }
}

#[test]
fn popup_labels_use_locale_file_copy() {
    let labels = translator_labels("en");

    assert_eq!(
        labels.get("sourceLabel").map(String::as_str),
        Some("Source Text")
    );
    assert_eq!(
        labels.get("copyBtn").map(String::as_str),
        Some("Copy translation")
    );
    assert_eq!(labels.get("copied").map(String::as_str), Some("Copied!"));
}
