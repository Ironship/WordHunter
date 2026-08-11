use super::*;

#[test]
fn attached_articles_use_the_bare_vocabulary_key() {
    assert_eq!(vocabulary_word_key("L'homme", "fr"), "homme");
    assert_eq!(vocabulary_word_key("l’homme", "fr-FR"), "homme");
    assert_eq!(vocabulary_word_key("L‘homme", "fr_FR"), "homme");
    assert_eq!(vocabulary_word_key("un’amica", "it"), "amica");
    assert_eq!(vocabulary_word_key("Un‘amica", "it_IT"), "amica");
    assert_eq!(vocabulary_word_key("d’homme", "fr"), "d'homme");
}
#[test]
fn resolve_algorithm_defaults_to_modern() {
    assert_eq!(resolve_algorithm(None), "modern");
    assert_eq!(resolve_algorithm(Some("")), "modern");
    assert_eq!(resolve_algorithm(Some("classic")), "classic");
}

#[test]
fn normalize_word_strips_punctuation_and_lowercases() {
    assert_eq!(normalize_word("Hello, World!"), "hello world");
    assert_eq!(normalize_word("  ???  "), "");
}

#[test]
fn vocabulary_keys_are_unicode_normalized_and_case_folded() {
    assert_eq!(
        vocabulary_word_key("Am", "de"),
        vocabulary_word_key("AM", "de")
    );
    assert_eq!(
        vocabulary_word_key("AM", "de"),
        vocabulary_word_key("am", "de")
    );
    assert_eq!(
        vocabulary_word_key("Straße", "de"),
        vocabulary_word_key("STRASSE", "de")
    );
    assert_eq!(normalize_word("Cafe\u{301}"), normalize_word("CAFÉ"));
    assert_eq!(
        vocabulary_word_key("ΟΣ", "grc"),
        vocabulary_word_key("ος", "grc")
    );
    assert_eq!(
        vocabulary_word_key("I", "tr"),
        vocabulary_word_key("ı", "tr")
    );
    assert_eq!(
        vocabulary_word_key("İ", "tr"),
        vocabulary_word_key("i", "tr")
    );
}

#[test]
fn normalize_search_variants_creates_german_and_ascii() {
    let variants = normalize_search_variants("Grüße");
    assert!(variants.iter().any(|v| v == "grüße"));
    assert!(variants.iter().any(|v| v == "gruesse"));
    assert!(variants.iter().any(|v| v == "gruße"));
}

#[test]
fn normalize_search_variants_creates_greek_accentless_form() {
    let variants = normalize_search_variants("λόγος");
    assert!(variants.iter().any(|v| v == "λόγος"));
    assert!(variants.iter().any(|v| v == "λογος"));
}
