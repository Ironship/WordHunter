use super::{SynthesisPermit, cached_with, rate_for, voice_for};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn failed_init_is_not_cached_and_the_next_call_retries() {
    let cache: Mutex<Option<u32>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    let init_fail = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Err::<u32, _>("temporary failure".to_string())
    };
    let init_ok = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(7)
    };
    assert_eq!(
        cached_with(&cache, init_fail),
        Err("temporary failure".to_string())
    );
    // The failure must NOT be cached: the next call runs `init` again.
    assert_eq!(cached_with(&cache, init_ok), Ok(7));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn successful_init_is_cached_across_calls() {
    let cache: Mutex<Option<u32>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    let init = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(7)
    };
    assert_eq!(cached_with(&cache, init), Ok(7));
    assert_eq!(cached_with(&cache, || Ok(9)), Ok(7));
    assert_eq!(cached_with(&cache, || Ok(9)), Ok(7));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

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
