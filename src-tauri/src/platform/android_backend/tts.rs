pub fn synthesize(_text: &str, _lang: &str) -> Result<Vec<u8>, String> {
    Err("Edge TTS is desktop-only. Pocket will use Android/WebView speech output.".to_string())
}
