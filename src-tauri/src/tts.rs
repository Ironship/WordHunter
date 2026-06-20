use edge_tts_rust::{Boundary, EdgeTtsClient, SpeakOptions};

pub fn synthesize(text: &str, lang: &str) -> Result<Vec<u8>, String> {
    let text = text.to_string();
    let voice = voice_for(lang).to_string();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    runtime.block_on(async move {
        let client = EdgeTtsClient::builder()
            .ws_pool_size(0)
            .ws_warmup(false)
            .build()
            .map_err(|e| e.to_string())?;
        let result = client
            .synthesize(
                text,
                SpeakOptions {
                    voice,
                    boundary: Boundary::Sentence,
                    ..SpeakOptions::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(result.audio)
    })
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
        _ => "en-US-AriaNeural",
    }
}

#[cfg(test)]
#[path = "tests/tts/tests.rs"]
mod tests;
