use super::*;

#[test]
fn maps_all_nine_languages() {
    assert_eq!(yg_lang_from_code("en"), "english");
    assert_eq!(yg_lang_from_code("de"), "german");
    assert_eq!(yg_lang_from_code("es"), "spanish");
    assert_eq!(yg_lang_from_code("it"), "italian");
    assert_eq!(yg_lang_from_code("fr"), "french");
    assert_eq!(yg_lang_from_code("pl"), "polish");
    assert_eq!(yg_lang_from_code("ru"), "russian");
    assert_eq!(yg_lang_from_code("uk"), "ukrainian");
    assert_eq!(yg_lang_from_code("ja"), "japanese");
}

#[test]
fn defaults_to_english_for_unknown() {
    assert_eq!(yg_lang_from_code("xx"), "english");
    assert_eq!(yg_lang_from_code(""), "english");
}

#[test]
fn handle_lang_returns_code_and_mapped_name() {
    let result = handle(json!({ "op": "lang", "code": "de" })).unwrap();
    assert_eq!(result["code"], "de");
    assert_eq!(result["yg_lang"], "german");
}

#[test]
fn handle_langs_returns_full_map() {
    let result = handle(json!({ "op": "langs" })).unwrap();
    let map = result["langs"].as_object().unwrap();
    assert_eq!(map.get("en").unwrap(), "english");
    assert_eq!(map.len(), 9);
}

#[test]
fn handle_rejects_unknown_op() {
    assert!(handle(json!({ "op": "nope" })).is_err());
}
