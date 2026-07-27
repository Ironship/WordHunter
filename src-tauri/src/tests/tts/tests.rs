use super::{SynthesisPermit, rate_for, voice_for};

#[test]
fn maps_only_supported_rate_presets() {
    assert_eq!(rate_for("slow"), "-25%");
    assert_eq!(rate_for("normal"), "+0%");
    assert_eq!(rate_for("fast"), "+25%");
    assert_eq!(rate_for("<prosody rate='999%'>"), "+0%");
}

#[test]
fn maps_known_languages_to_native_voices() {
    assert_eq!(voice_for("pl"), "pl-PL-MarekNeural");
    assert_eq!(voice_for("en"), "en-US-AriaNeural");
    assert_eq!(voice_for("de"), "de-DE-ConradNeural");
    assert_eq!(voice_for("zh"), "zh-CN-YunjianNeural");
    assert_eq!(voice_for("grc"), "el-GR-NestorasNeural");
}

#[test]
fn falls_back_to_english_for_unknown() {
    assert_eq!(voice_for("xx"), "en-US-AriaNeural");
    assert_eq!(voice_for(""), "en-US-AriaNeural");
}

#[test]
fn synthesis_permits_reject_at_capacity_and_release_on_drop() {
    let first = SynthesisPermit::acquire().expect("first permit");
    let second = SynthesisPermit::acquire().expect("second permit");
    assert_eq!(
        SynthesisPermit::acquire().err().as_deref(),
        Some("TTS is busy; retry")
    );
    drop(first);
    let replacement = SynthesisPermit::acquire().expect("released permit");
    drop((second, replacement));
}
