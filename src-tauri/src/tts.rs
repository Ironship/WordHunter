use edge_tts_rust::{Boundary, EdgeTtsClient, SpeakOptions, SynthesisResult};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const MAX_CONCURRENT_SYNTHESIS: usize = 2;
const SYNTHESIS_TIMEOUT_SECONDS: u64 = 14;
static ACTIVE_SYNTHESIS: AtomicUsize = AtomicUsize::new(0);
static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
static CLIENT: OnceLock<Result<EdgeTtsClient, String>> = OnceLock::new();

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

fn runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(MAX_CONCURRENT_SYNTHESIS)
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn client() -> Result<EdgeTtsClient, String> {
    match CLIENT.get_or_init(|| {
        EdgeTtsClient::builder()
            // Dropping a timed-out synthesis is not cancellation-safe for pooled sockets.
            .ws_pool_size(0)
            .ws_warmup(false)
            .build()
            .map_err(|error| error.to_string())
    }) {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(error.clone()),
    }
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
