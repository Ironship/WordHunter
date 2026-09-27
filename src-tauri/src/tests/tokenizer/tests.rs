use super::*;

#[test]
fn attached_articles_use_the_bare_vocabulary_key() {
    assert_eq!(vocabulary_word_key("L'homme", "fr"), "homme");
    assert_eq!(vocabulary_word_key("l’homme", "fr-FR"), "homme");
    assert_eq!(vocabulary_word_key("L‘homme", "fr_FR"), "homme");
    assert_eq!(vocabulary_word_key("un’amica", "it"), "amica");
    assert_eq!(vocabulary_word_key("Un‘amica", "it_IT"), "amica");
    // Other elided words are keys of the word they are written onto.
    assert_eq!(vocabulary_word_key("d’homme", "fr"), "homme");
    assert_eq!(vocabulary_word_key("Qu'il", "fr"), "il");
    assert_eq!(vocabulary_word_key("jusqu’à", "fr"), "à");
    assert_eq!(vocabulary_word_key("dell'acqua", "it"), "acqua");
    assert_eq!(vocabulary_word_key("All’inizio", "it"), "inizio");
    assert_eq!(vocabulary_word_key("aujourd'hui", "fr"), "aujourd'hui");
    assert_eq!(vocabulary_word_key("d'amour", "de"), "d'amour");
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

#[test]
fn greek_grave_and_acute_forms_share_a_key() {
    assert_eq!(
        vocabulary_word_key("θεὰ", "grc"),
        vocabulary_word_key("θεά", "grc")
    );
    assert_eq!(
        vocabulary_word_key("Θεά", "grc"),
        vocabulary_word_key("θεά", "grc")
    );
    assert_eq!(
        vocabulary_word_key("καὶ", "el"),
        vocabulary_word_key("καί", "el")
    );
    // Polytonic breathings stay distinct.
    assert_ne!(
        vocabulary_word_key("ὁ", "grc"),
        vocabulary_word_key("ὀ", "grc")
    );
}

#[test]
fn ukrainian_modifier_apostrophe_is_an_apostrophe() {
    assert_eq!(
        vocabulary_word_key("памʼять", "uk"),
        vocabulary_word_key("пам'ять", "uk")
    );
    assert_eq!(vocabulary_word_key("пам’ять", "uk"), "пам'ять");
}
