use super::translate;
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
    // Lines and paragraphs of a translated text stay.
    assert_eq!(
        clean_translation("First  line .\nSecond line\n\n\n\nNext paragraph ".to_string()),
        "First line.\nSecond line\n\nNext paragraph"
    );
}

#[test]
fn empty_translation_query_is_rejected_without_leaking_model_details() {
    let error = translate("").unwrap_err();
    assert!(error.contains("missing text"));
    assert!(!error.to_ascii_lowercase().contains("model"));
}

#[test]
fn default_labels_use_neutral_translator_name() {
    let labels = translator_labels("en");
    assert_eq!(
        labels.get("title").map(String::as_str),
        Some("Offline Translator")
    );
    for key in [
        "title",
        "sourceLabel",
        "targetLabel",
        "placeholder",
        "targetPlaceholder",
        "footer",
        "copyBtn",
        "copied",
    ] {
        let value = labels
            .get(key)
            .unwrap_or_else(|| panic!("missing label {key}"));
        assert!(!value.trim().is_empty(), "label {key} is empty");
    }
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

#[test]
fn offline_translation_is_split_into_sentences_and_lines() {
    use super::translator::ct2::translation_segments;

    let segments = |text: &str| translation_segments(text);
    let line = |parts: &[&str]| {
        parts
            .iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
    };

    // Short lines go whole; blank lines stay as paragraph breaks.
    assert_eq!(
        segments("Das ist gut. Wirklich? Ja!\n\nZweiter Absatz."),
        vec![
            line(&["Das ist gut. Wirklich? Ja!"]),
            Vec::new(),
            line(&["Zweiter Absatz."])
        ]
    );
    // A hard-wrapped sentence is one line again; a finished line is not.
    assert_eq!(
        segments("Er ging langsam\nnach Hause.\n– Wirklich?\n– Ja."),
        vec![
            line(&["Er ging langsam nach Hause."]),
            line(&["– Wirklich?"]),
            line(&["– Ja."])
        ]
    );

    // Long lines are split into sentences, but not after abbreviations,
    // ordinals or before a lowercase word.
    let filler = "Das Wetter war schön und alle waren draußen im Garten ".repeat(6);
    let long = format!(
        "Am 3. Mai kam Dr. Weber, z. B. mit Tee. {filler}and! Und dann? ja, so war es. Ende 1.1.2 da."
    );
    assert_eq!(
        segments(&long),
        vec![line(&[
            "Am 3. Mai kam Dr. Weber, z. B. mit Tee.",
            &format!("{filler}and!"),
            "Und dann? ja, so war es.",
            "Ende 1.1.2 da."
        ])]
    );
    // A closing quote stays with the sentence it ends, and "?!" is one end.
    let japanese = format!("{}「こんにちは。」と彼は言った。", "あ".repeat(300));
    assert_eq!(
        segments(&japanese),
        vec![line(&[
            &format!("{}「こんにちは。」", "あ".repeat(300)),
            "と彼は言った。"
        ])]
    );
    let quoted = format!("{filler}. Er rief: „Halt!“ Dann ging er?! Ja.");
    assert_eq!(
        segments(&quoted),
        vec![line(&[
            &format!("{filler}."),
            "Er rief: „Halt!“",
            "Dann ging er?!",
            "Ja."
        ])]
    );
    let chinese = format!("{}。我是学生。", "你好".repeat(160));
    assert_eq!(
        segments(&chinese),
        vec![line(&[&format!("{}。", "你好".repeat(160)), "我是学生。"])]
    );
}
