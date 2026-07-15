use super::*;

#[test]
fn classic_tokenize_keeps_punctuation() {
    let parts = tokenize("Hello, world!", "en", Some("classic"));
    assert_eq!(
        parts,
        vec![
            Token {
                kind: "word".into(),
                value: "Hello".into()
            },
            Token {
                kind: "text".into(),
                value: ", ".into()
            },
            Token {
                kind: "word".into(),
                value: "world".into()
            },
            Token {
                kind: "text".into(),
                value: "!".into()
            },
        ]
    );
}

#[test]
fn tokenize_handles_hyphenated_and_apostrophe_words() {
    let parts = tokenize("it's a well-known fact", "en", Some("classic"));
    let words: Vec<String> = parts
        .iter()
        .filter(|p| p.kind == "word")
        .map(|p| p.value.clone())
        .collect();
    assert_eq!(words, vec!["it's", "a", "well-known", "fact"]);
}

#[test]
fn tokenizers_keep_typographic_apostrophe_words_together() {
    for algorithm in ["classic", "modern"] {
        let parts = tokenize("L’homme et un’amica", "fr", Some(algorithm));
        let words: Vec<String> = parts
            .iter()
            .filter(|part| part.kind == "word")
            .map(|part| part.value.clone())
            .collect();
        assert_eq!(words, vec!["L’homme", "et", "un’amica"], "{algorithm}");
    }
}

#[test]
fn attached_articles_use_the_bare_vocabulary_key() {
    assert_eq!(vocabulary_word_key("L'homme", "fr"), "homme");
    assert_eq!(vocabulary_word_key("l’homme", "fr-FR"), "homme");
    assert_eq!(vocabulary_word_key("un’amica", "it"), "amica");
    assert_eq!(vocabulary_word_key("d’homme", "fr"), "d'homme");
}

#[test]
fn image_markers_become_image_tokens() {
    let parts = tokenize("front [IMG:cover.jpg] back", "en", Some("classic"));
    let kinds: Vec<&str> = parts.iter().map(|p| p.kind.as_str()).collect();
    assert_eq!(kinds, vec!["word", "text", "image", "text", "word"]);
    let image = parts.iter().find(|p| p.kind == "image").unwrap();
    assert_eq!(image.value, "cover.jpg");
}

#[test]
fn adjacent_text_segments_collapse() {
    let mut parts = vec![
        Token {
            kind: "word".into(),
            value: "a".into(),
        },
        Token {
            kind: "text".into(),
            value: ",".into(),
        },
        Token {
            kind: "text".into(),
            value: " ".into(),
        },
        Token {
            kind: "text".into(),
            value: ";".into(),
        },
        Token {
            kind: "word".into(),
            value: "b".into(),
        },
    ];

    merge_adjacent_text(&mut parts);

    assert_eq!(
        parts,
        vec![
            Token {
                kind: "word".into(),
                value: "a".into(),
            },
            Token {
                kind: "text".into(),
                value: ", ;".into(),
            },
            Token {
                kind: "word".into(),
                value: "b".into(),
            },
        ]
    );
}

#[test]
fn modern_tokenize_returns_words() {
    let parts = tokenize("Hello, world!", "en", Some("modern"));
    let words: Vec<String> = parts
        .iter()
        .filter(|p| p.kind == "word")
        .map(|p| p.value.clone())
        .collect();
    assert_eq!(words, vec!["Hello", "world"]);
}

#[test]
fn modern_tokenize_splits_hyphenated_words() {
    let parts = tokenize("well-known fact", "en", Some("modern"));
    let words: Vec<String> = parts
        .iter()
        .filter(|p| p.kind == "word")
        .map(|p| p.value.clone())
        .collect();
    assert_eq!(words, vec!["well", "known", "fact"]);
}

#[test]
fn word_visitor_matches_tokenize_for_every_algorithm() {
    let text = "Hello, well-known [IMG:cover.jpg] Grüß Gott!";
    for algorithm in ["classic", "modern"] {
        let expected: Vec<String> = tokenize(text, "de", Some(algorithm))
            .into_iter()
            .filter(|token| token.kind == "word")
            .map(|token| token.value)
            .collect();
        let mut actual = Vec::new();
        for_each_word(text, "de", Some(algorithm), |word| {
            actual.push(word.to_string())
        });
        assert_eq!(actual, expected, "algorithm: {algorithm}");
    }
}

#[test]
fn empty_input_returns_empty_list() {
    assert!(tokenize("", "en", Some("modern")).is_empty());
    assert!(tokenize("", "en", Some("classic")).is_empty());
}

#[test]
fn resolve_algorithm_defaults_to_modern() {
    assert_eq!(resolve_algorithm(None), "modern");
    assert_eq!(resolve_algorithm(Some("")), "modern");
    assert_eq!(resolve_algorithm(Some("classic")), "classic");

    let default = tokenize("well-known", "en", None);
    let modern = tokenize("well-known", "en", Some("modern"));
    let classic = tokenize("well-known", "en", Some("classic"));
    assert_eq!(default, modern);
    assert_ne!(default, classic);
}

#[test]
fn normalize_word_strips_punctuation_and_lowercases() {
    assert_eq!(normalize_word("Hello, World!"), "hello world");
    assert_eq!(normalize_word("  ???  "), "");
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
fn clean_gutenberg_trims_headers_and_collapses_blank_lines() {
    let raw = "*** START OF THE PROJECT GUTENBERG EBOOK X ***\nFirst.\n\n\n\nSecond.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\n";
    let out = clean_gutenberg_text(raw);
    assert_eq!(out, "First.\n\nSecond.");
}

#[test]
fn clean_gutenberg_passthrough_when_no_markers() {
    let raw = "just some text\n\n\nwith blanks";
    let out = clean_gutenberg_text(raw);
    assert_eq!(out, "just some text\n\nwith blanks");
}

#[test]
fn stats_counts_unique_words_and_vocab_status() {
    let text = "the cat sat on the mat";
    let vocab = json!({
        "cat": { "status": "learning" },
        "the": { "status": "known" }
    });
    let stats = text_stats(text, &vocab, "en", Some("classic"));
    assert_eq!(stats["unique"], 5);
    assert_eq!(stats["known"], 2);
    assert_eq!(stats["learning"], 1);
    assert_eq!(stats["new"], 3);
}

#[test]
fn stats_canonicalize_attached_articles_and_preserve_legacy_vocab() {
    let canonical = text_stats(
        "L'homme l’homme",
        &json!({ "homme": { "status": "known" } }),
        "fr",
        Some("classic"),
    );
    assert_eq!(canonical["unique"], 1);
    assert_eq!(canonical["known"], 2);

    let legacy = text_stats(
        "L’homme",
        &json!({ "l’homme": { "status": "learning" } }),
        "fr",
        Some("classic"),
    );
    assert_eq!(legacy["learning"], 1);
}

#[test]
fn handle_dispatches_tokenize() {
    let result = handle(json!({
        "op": "tokenize",
        "text": "Hi!",
        "lang": "en",
        "algorithm": "classic"
    }))
    .unwrap();
    let kinds: Vec<&str> = result["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["word", "text"]);
}

#[test]
fn handle_rejects_unknown_op() {
    let err = handle(json!({ "op": "nope" })).unwrap_err();
    assert!(err.contains("unknown tokenizer op"));
}
