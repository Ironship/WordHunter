use edge_tts_rust::{Boundary, EdgeTtsClient, SpeakOptions, SynthesisResult};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const MAX_CONCURRENT_SYNTHESIS: usize = 2;
const SYNTHESIS_TIMEOUT_SECONDS: u64 = 14;
static ACTIVE_SYNTHESIS: AtomicUsize = AtomicUsize::new(0);
static RUNTIME: Mutex<Option<tokio::runtime::Handle>> = Mutex::new(None);
static CLIENT: Mutex<Option<EdgeTtsClient>> = Mutex::new(None);

struct SynthesisPermit;

impl SynthesisPermit {
    fn acquire() -> Result<Self, String> {
        ACTIVE_SYNTHESIS
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |active| {
                (active < MAX_CONCURRENT_SYNTHESIS).then_some(active + 1)
            })
            .map(|_| Self)
            .map_err(|_| "TTS is busy; retry".to_string())
    }
}

impl Drop for SynthesisPermit {
    fn drop(&mut self) {
        ACTIVE_SYNTHESIS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Returns the cached value when present, otherwise runs `init` and caches
/// the result. Only successes are cached: a failed `init` is retried on the
/// next call (unlike `OnceLock::get_or_init`, which would cache the error
/// forever).
fn cached_with<T: Clone>(
    cache: &Mutex<Option<T>>,
    init: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(value) = cache.lock().unwrap().as_ref() {
        return Ok(value.clone());
    }
    let built = init()?;
    let mut guard = cache.lock().unwrap();
    Ok(guard.get_or_insert(built).clone())
}

fn runtime() -> Result<tokio::runtime::Handle, String> {
    cached_with(&RUNTIME, || {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(MAX_CONCURRENT_SYNTHESIS)
            .enable_all()
            .build()
            .map(|runtime| runtime.handle().clone())
            .map_err(|error| error.to_string())
    })
}

fn client() -> Result<EdgeTtsClient, String> {
    cached_with(&CLIENT, || {
        EdgeTtsClient::builder()
            // Dropping a timed-out synthesis is not cancellation-safe for pooled sockets.
            .ws_pool_size(0)
            .ws_warmup(false)
            .build()
            .map_err(|error| error.to_string())
    })
}

pub fn synthesize(text: &str, lang: &str, rate: &str) -> Result<SynthesisResult, String> {
    let _permit = SynthesisPermit::acquire()?;
    let text = text.to_string();
    let voice = voice_for(lang).to_string();
    let rate = rate_for(rate).to_string();
    let client = client()?;

    runtime()?.block_on(async move {
        tokio::time::timeout(
            Duration::from_secs(SYNTHESIS_TIMEOUT_SECONDS),
            client.synthesize(
                text,
                SpeakOptions {
                    voice,
                    rate,
                    boundary: Boundary::Word,
                    ..SpeakOptions::default()
                },
            ),
        )
        .await
        .map_err(|_| format!("TTS request timed out after {SYNTHESIS_TIMEOUT_SECONDS} seconds"))?
        .map_err(|error| error.to_string())
    })
}

fn rate_for(preset: &str) -> &'static str {
    match preset {
        "slow" => "-25%",
        "fast" => "+25%",
        _ => "+0%",
    }
}

fn voice_for(lang: &str) -> &'static str {
    match lang {
        "pl" => "pl-PL-MarekNeural",
        "en" => "en-US-AriaNeural",
        "de" => "de-DE-ConradNeural",
        "es" => "es-ES-AlvaroNeural",
        "fr" => "fr-FR-HenriNeural",
        "it" => "it-IT-DiegoNeural",
        "uk" => "uk-UA-OstapNeural",
        "ru" => "ru-RU-DmitryNeural",
        "ja" => "ja-JP-KeitaNeural",
        "zh" => "zh-CN-YunjianNeural",
        "grc" => "el-GR-NestorasNeural",
        _ => "en-US-AriaNeural",
    }
}

#[cfg(test)]
#[path = "tests/tts/tests.rs"]
mod tests;
