use serde_json::{Value, json};

use crate::vocab_export;

fn run_op(payload: Value) -> Value {
    vocab_export::handle(payload).expect("handle succeeds")
}

fn vocab_entry(_word: &str, status: &str, translation: &str) -> Value {
    json!({
        "status": status,
        "translation": translation,
        "note": "",
        "examples": []
    })
}

#[test]
fn handle_rejects_missing_op() {
    let err = vocab_export::handle(json!({})).expect_err("missing op rejected");
    assert!(err.contains("op"));
}

#[test]
fn handle_rejects_unknown_op() {
    let err = vocab_export::handle(json!({ "op": "nope" })).expect_err("unknown op");
    assert!(err.contains("nope"));
}

#[test]
fn query_returns_all_entries_with_default_statuses() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", "alef"),
        "beta": vocab_entry("beta", "known", "bet"),
        "gamma": vocab_entry("gamma", "ignored", ""),
        "delta": vocab_entry("delta", "new", "")
    });
    let result = run_op(json!({ "op": "query", "vocab": vocab }));
    let entries = result["entries"].as_array().expect("array");
    assert_eq!(entries.len(), 4);
}

#[test]
fn query_filters_by_status() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", ""),
        "beta": vocab_entry("beta", "known", ""),
        "gamma": vocab_entry("gamma", "ignored", "")
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "statuses": ["learning", "known"]
    }));
    let entries = result["entries"].as_array().unwrap();
    let words: Vec<&str> = entries
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["alpha", "beta"]);
}

#[test]
fn query_filters_by_query_against_word_translation_note() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", "first letter"),
        "beta": { "status": "learning", "translation": "alef is greek", "note": "phoneme", "examples": [] },
        "gamma": vocab_entry("gamma", "learning", "unrelated")
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "query": "alef"
    }));
    let entries = result["entries"].as_array().unwrap();
    let words: Vec<&str> = entries
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["beta"]);
}

#[test]
fn query_matches_article_field() {
    let vocab = json!({
        "haus": { "status": "learning", "article": "das", "translation": "house", "note": "", "examples": [] },
        "wohnung": { "status": "learning", "article": "die", "translation": "flat", "note": "", "examples": [] }
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "query": "das"
    }));
    let words: Vec<&str> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["haus"]);
}

#[test]
fn query_matches_apostrophe_article_as_displayed() {
    let result = run_op(json!({
        "op": "query",
        "vocab": {
            "homme": {
                "status": "learning",
                "article": "l'",
                "translation": "man",
                "note": "",
                "examples": []
            }
        },
        "query": "l'homme",
        "lang": "fr"
    }));
    assert_eq!(result["entries"][0]["word"], "homme");
}

#[test]
fn query_matches_word_field_directly() {
    let vocab = json!({
        "alef": vocab_entry("alef", "learning", ""),
        "beta": vocab_entry("beta", "learning", "")
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "query": "alef"
    }));
    let words: Vec<&str> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["alef"]);
}

#[test]
fn query_filters_by_text_index() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", ""),
        "beta": vocab_entry("beta", "learning", ""),
        "gamma": vocab_entry("gamma", "learning", "")
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "textIndex": { "words": ["alpha", "beta"], "tokenLine": " alpha beta " }
    }));
    let entries = result["entries"].as_array().unwrap();
    let words: Vec<&str> = entries
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["alpha", "beta"]);
}

#[test]
fn query_text_index_matches_legacy_attached_article_keys() {
    let result = run_op(json!({
        "op": "query",
        "vocab": {
            "l’homme": {
                "status": "learning",
                "article": "l'",
                "translation": "man",
                "note": "",
                "examples": []
            }
        },
        "lang": "fr",
        "textIndex": { "words": ["homme"], "tokenLine": " homme " }
    }));
    assert_eq!(result["entries"][0]["word"], "l’homme");
}

#[test]
fn query_supports_multi_word_phrases_via_text_index() {
    let vocab = json!({
        "alpha beta": vocab_entry("alpha beta", "learning", ""),
        "alpha": vocab_entry("alpha", "learning", ""),
    });
    let result = run_op(json!({
        "op": "query",
        "vocab": vocab,
        "textIndex": { "words": ["alpha", "beta"], "tokenLine": " alpha beta " }
    }));
    let entries = result["entries"].as_array().unwrap();
    let words: Vec<&str> = entries
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["alpha", "alpha beta"]);
}

#[test]
fn query_sorts_alphabetically_case_insensitive() {
    let vocab = json!({
        "Banana": vocab_entry("Banana", "learning", ""),
        "apple": vocab_entry("apple", "learning", ""),
        "Cherry": vocab_entry("Cherry", "learning", ""),
    });
    let result = run_op(json!({ "op": "query", "vocab": vocab }));
    let entries = result["entries"].as_array().unwrap();
    let words: Vec<&str> = entries
        .iter()
        .map(|e| e["word"].as_str().unwrap())
        .collect();
    assert_eq!(words, vec!["apple", "Banana", "Cherry"]);
}

#[test]
fn query_includes_word_field_on_entries() {
    let vocab = json!({ "alpha": vocab_entry("alpha", "learning", "") });
    let result = run_op(json!({ "op": "query", "vocab": vocab }));
    let entry = &result["entries"][0];
    assert_eq!(entry["word"], "alpha");
    assert_eq!(entry["status"], "learning");
}

#[test]
fn export_returns_anki_tsv_with_default_header() {
    let vocab = json!({
        "alpha": { "status": "learning", "translation": "alef", "note": "", "examples": ["An example sentence."] },
        "beta": { "status": "known", "translation": "bet", "note": "second", "examples": [] }
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "anki",
        "filename": "out.tsv"
    }));
    assert_eq!(result["filename"], "out.tsv");
    assert_eq!(result["mime"], "text/tab-separated-values");
    let content = result["content"].as_str().unwrap();
    assert!(content.starts_with("word\ttranslation\tcontext\tarticle\n"));
    assert!(content.contains("alpha\talef\tAn example sentence."));
    assert!(content.contains("beta\tbet\tsecond"));
    assert_eq!(result["count"], 2);
}

#[test]
fn export_returns_anki_tsv_with_custom_header() {
    let vocab = json!({ "alpha": vocab_entry("alpha", "learning", "") });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "anki",
        "filename": "out.tsv",
        "headerRow": "Word\tTranslation\tSentence\n"
    }));
    let content = result["content"].as_str().unwrap();
    assert!(content.starts_with("Word\tTranslation\tSentence\n"));
}

#[test]
fn export_includes_article_as_optional_fourth_anki_column() {
    let vocab = json!({
        "haus": { "status": "learning", "article": "das", "translation": "house", "note": "", "examples": ["Das Haus ist groß."] },
        "lernen": vocab_entry("lernen", "learning", "learn")
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "anki",
        "filename": "out.tsv"
    }));
    let content = result["content"].as_str().unwrap();
    assert!(content.contains("haus\thouse\tDas Haus ist groß.\tdas\n"));
    assert!(content.contains("lernen\tlearn\t\t\n"));
}

#[test]
fn export_appends_extension_if_missing() {
    let vocab = json!({ "alpha": vocab_entry("alpha", "learning", "") });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "anki",
        "filename": "my-vocab"
    }));
    assert_eq!(result["filename"], "my-vocab.tsv");
}

#[test]
fn export_returns_words_txt() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", ""),
        "beta": vocab_entry("beta", "learning", "")
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "txt",
        "filename": "out"
    }));
    assert_eq!(result["filename"], "out.txt");
    assert_eq!(result["mime"], "text/plain;charset=utf-8");
    let content = result["content"].as_str().unwrap();
    assert_eq!(content, "alpha\nbeta\n");
}

#[test]
fn words_txt_formats_articles_with_language_appropriate_spacing() {
    let vocab = json!({
        "haus": { "status": "learning", "article": "das", "translation": "", "note": "", "examples": [] },
        "homme": { "status": "learning", "article": "l'", "translation": "", "note": "", "examples": [] },
        "amica": { "status": "learning", "article": "un’", "translation": "", "note": "", "examples": [] },
        "l’homme": { "status": "learning", "article": "l'", "translation": "", "note": "", "examples": [] },
        "plain": vocab_entry("plain", "learning", "")
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "txt",
        "filename": "out.txt"
    }));
    assert_eq!(
        result["content"],
        "un’amica\ndas haus\nl'homme\nl’homme\nplain\n"
    );
}

#[test]
fn export_cleans_tsv_cells() {
    let vocab = json!({
        "alpha": { "status": "learning", "translation": "tab\there\nnewline", "note": "", "examples": [] }
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "anki",
        "filename": "out.tsv"
    }));
    let content = result["content"].as_str().unwrap();
    assert!(content.contains("alpha\ttab here newline\t"));
}

#[test]
fn export_applies_statuses_filter() {
    let vocab = json!({
        "alpha": vocab_entry("alpha", "learning", ""),
        "beta": vocab_entry("beta", "known", ""),
        "gamma": vocab_entry("gamma", "ignored", "")
    });
    let result = run_op(json!({
        "op": "export",
        "vocab": vocab,
        "format": "txt",
        "filename": "out.txt",
        "statuses": ["learning"]
    }));
    let content = result["content"].as_str().unwrap();
    assert_eq!(content, "alpha\n");
    assert_eq!(result["count"], 1);
}

#[test]
fn export_rejects_unknown_format() {
    let err = vocab_export::handle(json!({
        "op": "export",
        "vocab": {},
        "format": "weird",
        "filename": "out"
    }))
    .expect_err("unknown format");
    assert!(err.contains("weird"));
}

#[test]
fn import_parses_anki_tsv_with_header() {
    let tsv = "word\ttranslation\tcontext\nalpha\talef\texample\nbeta\tbet\t\n";
    let result = run_op(json!({ "op": "import", "tsv": tsv }));
    assert_eq!(result["headerFound"], true);
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["word"], "alpha");
    assert_eq!(rows[0]["translation"], "alef");
    assert_eq!(rows[0]["context"], "example");
    assert_eq!(rows[0]["article"], "");
    assert_eq!(rows[1]["word"], "beta");
}

#[test]
fn import_keeps_headerless_words_that_resemble_localized_headers() {
    let result = run_op(json!({
        "op": "import",
        "tsv": "Mot\tword\texample\tle\n"
    }));
    assert_eq!(result["headerFound"], false);
    assert_eq!(result["rows"][0]["word"], "Mot");
    assert_eq!(result["rows"][0]["article"], "le");
}

#[test]
fn import_parses_optional_article_column_and_localized_headers() {
    for header in [
        "Word",
        "Słowo",
        "Wort",
        "Palabra",
        "Mot",
        "Parola",
        "単語",
        "Слово",
    ] {
        let tsv = format!("{header}\tTranslation\tContext\tArticle\nhaus\thouse\texample\tdas\n");
        let result = run_op(json!({ "op": "import", "tsv": tsv }));
        assert_eq!(result["headerFound"], true, "header: {header}");
        assert_eq!(result["rows"][0]["word"], "haus", "header: {header}");
        assert_eq!(result["rows"][0]["article"], "das", "header: {header}");
    }
}

#[test]
fn import_parses_anki_tsv_without_header() {
    let tsv = "alpha\talef\texample\nbeta\tbet\t\n";
    let result = run_op(json!({ "op": "import", "tsv": tsv }));
    assert_eq!(result["headerFound"], false);
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["word"], "alpha");
}

#[test]
fn import_skips_empty_lines_and_blank_words() {
    let tsv = "\nalpha\talef\texample\n\n\tempty\trow\n   \nbeta\tbet\t\n";
    let result = run_op(json!({ "op": "import", "tsv": tsv }));
    let rows = result["rows"].as_array().unwrap();
    let words: Vec<&str> = rows.iter().map(|r| r["word"].as_str().unwrap()).collect();
    assert_eq!(words, vec!["alpha", "beta"]);
}

#[test]
fn import_detects_header_case_insensitively() {
    let tsv = "Word\tTranslation\tContext\nalpha\talef\texample\n";
    let result = run_op(json!({ "op": "import", "tsv": tsv }));
    assert_eq!(result["headerFound"], true);
    assert_eq!(result["rows"].as_array().unwrap().len(), 1);
}

#[test]
fn import_handles_crlf_line_endings() {
    let tsv = "alpha\talef\texample\r\nbeta\tbet\tcontext\r\n";
    let result = run_op(json!({ "op": "import", "tsv": tsv }));
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["context"], "context");
}

#[test]
fn import_rejects_missing_tsv() {
    let err = vocab_export::handle(json!({ "op": "import" })).expect_err("missing tsv");
    assert!(err.contains("tsv"));
}
