use super::voice_for;

#[test]
fn maps_known_languages_to_native_voices() {
    assert_eq!(voice_for("pl"), "pl-PL-MarekNeural");
    assert_eq!(voice_for("en"), "en-US-AriaNeural");
    assert_eq!(voice_for("de"), "de-DE-ConradNeural");
}

#[test]
fn falls_back_to_english_for_unknown() {
    assert_eq!(voice_for("xx"), "en-US-AriaNeural");
    assert_eq!(voice_for(""), "en-US-AriaNeural");
}
