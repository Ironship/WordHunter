use serde_json::{Value, json};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use url::Url;

use crate::subtitles;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const MAX_WATCH_BODY: u64 = 8 * 1024 * 1024;
const MAX_CAPTION_BODY: u64 = 5 * 1024 * 1024;

struct VideoInfo {
    id: String,
    title: String,
    author: String,
    thumbnail_url: String,
    player: Value,
}

pub fn handle(payload: Value) -> Result<Value, String> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing op".to_string())?;
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing url".to_string())?;

    match op {
        "tracks" => {
            let info = fetch_video_info(url)?;
            Ok(json!({
                "videoId": info.id,
                "title": info.title,
                "author": info.author,
                "thumbnailUrl": info.thumbnail_url,
                "sourceUrl": watch_url(&info.id),
                "tracks": tracks_from_player(&info.player),
            }))
        }
        "download" => {
            let track_index = payload
                .get("track_index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing track_index".to_string())?
                as usize;
            let info = fetch_video_info(url)?;
            let track = caption_track_at(&info.player, track_index)
                .ok_or_else(|| "caption track not found".to_string())?;
            let text = download_caption_text(&info, track)?;
            Ok(json!({
                "videoId": info.id,
                "title": info.title,
                "author": info.author,
                "thumbnailUrl": info.thumbnail_url,
                "sourceUrl": watch_url(&info.id),
                "text": text,
                "track": track_json(track_index, track),
            }))
        }
        other => Err(format!("unknown youtube captions op: {other}")),
    }
}

fn download_caption_text(info: &VideoInfo, track: &Value) -> Result<String, String> {
    let direct_error = match download_caption_text_direct(track) {
        Ok(text) if !text.trim().is_empty() => return Ok(text),
        Ok(_) => "caption track is empty".to_string(),
        Err(err) => err,
    };
    download_caption_text_with_ytdlp(info, track).map_err(|fallback_error| {
        format!(
            "Could not download YouTube captions. Direct captions failed: {direct_error}. yt-dlp fallback failed: {fallback_error}"
        )
    })
}

fn download_caption_text_direct(track: &Value) -> Result<String, String> {
    let caption_url = format_caption_url(
        track
            .get("baseUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| "caption track has no url".to_string())?,
    );
    let raw = fetch_text(&caption_url, MAX_CAPTION_BODY)?;
    caption_body_to_text(&raw)
}

fn download_caption_text_with_ytdlp(info: &VideoInfo, track: &Value) -> Result<String, String> {
    let language = ytdlp_track_language(track)
        .ok_or_else(|| "caption track has no language code".to_string())?;
    let mut errors = Vec::new();
    for command in ytdlp_commands() {
        match run_ytdlp(&command, info, track, &language) {
            Ok(text) => return Ok(text),
            Err(err) => errors.push(format!("{}: {err}", command.to_string_lossy())),
        }
    }

    if errors.is_empty() {
        return Err("yt-dlp was not found; install yt-dlp or set WORDHUNTER_YTDLP".to_string());
    }
    Err(errors.join("; "))
}

fn run_ytdlp(
    command: &OsString,
    info: &VideoInfo,
    track: &Value,
    language: &str,
) -> Result<String, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output_template = temp.path().join("%(id)s.%(ext)s");
    let mut process = Command::new(command);
    process
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-progress")
        .arg("--no-warnings")
        .arg(if track_is_auto_generated(track) {
            "--write-auto-subs"
        } else {
            "--write-subs"
        })
        .arg("--sub-langs")
        .arg(language)
        .arg("--sub-format")
        .arg("vtt")
        .arg("-o")
        .arg(&output_template)
        .arg(watch_url(&info.id));
    let output = process.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(process_error(&output));
    }
    let path = find_subtitle_file(temp.path())?
        .ok_or_else(|| "yt-dlp did not write a subtitle file".to_string())?;
    let raw = read_caption_file(&path)?;
    let text = caption_body_to_text(&raw)?;
    if text.trim().is_empty() {
        return Err("yt-dlp returned empty captions".to_string());
    }
    Ok(text)
}

fn ytdlp_commands() -> Vec<OsString> {
    let mut commands = Vec::new();
    if let Some(value) = env::var_os("WORDHUNTER_YTDLP").filter(|value| !value.is_empty()) {
        commands.push(value);
    }
    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        for name in ytdlp_names() {
            commands.push(dir.join(name).into_os_string());
            commands.push(dir.join("bin").join(name).into_os_string());
        }
    }
    for name in ytdlp_names() {
        commands.push(OsString::from(name));
    }
    dedupe_os_strings(commands)
}

fn ytdlp_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["yt-dlp.exe", "yt-dlp"]
    } else {
        &["yt-dlp"]
    }
}

fn dedupe_os_strings(values: Vec<OsString>) -> Vec<OsString> {
    let mut deduped = Vec::new();
    for value in values {
        if !deduped.iter().any(|existing| existing == &value) {
            deduped.push(value);
        }
    }
    deduped
}

fn ytdlp_track_language(track: &Value) -> Option<String> {
    track
        .get("languageCode")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            track
                .get("vssId")
                .and_then(Value::as_str)
                .map(|value| value.trim_start_matches("a.").trim_start_matches('.'))
                .filter(|value| !value.is_empty())
        })
        .map(str::to_string)
}

fn track_is_auto_generated(track: &Value) -> bool {
    track.get("kind").and_then(Value::as_str) == Some("asr")
}

fn find_subtitle_file(dir: &Path) -> Result<Option<PathBuf>, String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            if let Some(found) = find_subtitle_file(&path)? {
                return Ok(Some(found));
            }
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "vtt" | "xml" | "ttml") {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn read_caption_file(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_CAPTION_BODY {
        return Err("caption file is too large".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn process_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut message = if stderr.is_empty() { stdout } else { stderr };
    if message.is_empty() {
        message = format!("exit code {}", output.status);
    }
    if message.len() > 600 {
        let mut end = 600;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str("...");
    }
    message
}

fn fetch_video_info(input_url: &str) -> Result<VideoInfo, String> {
    let id = video_id_from_url(input_url)?;
    let html = fetch_text(&watch_url(&id), MAX_WATCH_BODY)?;
    let player = player_response_from_html(&html)?;
    let title = player
        .pointer("/videoDetails/title")
        .and_then(Value::as_str)
        .map(clean_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "YouTube video".to_string());
    let thumbnail_url = thumbnail_url(&player)
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
    let author = player
        .pointer("/videoDetails/author")
        .and_then(Value::as_str)
        .map(clean_text)
        .unwrap_or_default();
    Ok(VideoInfo {
        id,
        title,
        author,
        thumbnail_url,
        player,
    })
}

fn fetch_text(url: &str, max_bytes: u64) -> Result<String, String> {
    let response = crate::http::agent()
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept-Language", "en-US,en;q=0.8")
        .set("Cookie", "CONSENT=YES+1")
        .call()
        .map_err(|e| e.to_string())?;
    let mut reader = response.into_reader().take(max_bytes + 1);
    let mut text = String::new();
    reader
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > max_bytes {
        return Err("YouTube response is too large".to_string());
    }
    Ok(text)
}

fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}&hl=en")
}

fn video_id_from_url(value: &str) -> Result<String, String> {
    let raw = value.trim();
    if is_video_id(raw) {
        return Ok(raw.to_string());
    }

    let parsed = Url::parse(raw).map_err(|_| "invalid YouTube URL".to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|parts| parts.collect())
        .unwrap_or_default();

    if host == "youtu.be" {
        return segments
            .first()
            .filter(|id| is_video_id(id))
            .map(|id| (*id).to_string())
            .ok_or_else(|| "invalid YouTube video id".to_string());
    }

    if !matches!(
        host.as_str(),
        "youtube.com"
            | "www.youtube.com"
            | "m.youtube.com"
            | "music.youtube.com"
            | "www.youtube-nocookie.com"
    ) {
        return Err("URL is not a supported YouTube link".to_string());
    }

    if let Some(id) = parsed
        .query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
        .filter(|id| is_video_id(id))
    {
        return Ok(id);
    }

    for marker in ["shorts", "embed", "live"] {
        if segments.first() == Some(&marker) {
            return segments
                .get(1)
                .filter(|id| is_video_id(id))
                .map(|id| (*id).to_string())
                .ok_or_else(|| "invalid YouTube video id".to_string());
        }
    }

    Err("could not find YouTube video id".to_string())
}

fn is_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn player_response_from_html(html: &str) -> Result<Value, String> {
    let marker = "ytInitialPlayerResponse";
    let start = html
        .find(marker)
        .ok_or_else(|| "YouTube player response not found".to_string())?;
    let rest = &html[start + marker.len()..];
    let brace = rest
        .find('{')
        .ok_or_else(|| "YouTube player response is malformed".to_string())?;
    let json_text = extract_json_object(&rest[brace..])?;
    serde_json::from_str(json_text).map_err(|e| e.to_string())
}

fn extract_json_object(input: &str) -> Result<&str, String> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in input.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok(&input[..index + ch.len_utf8()]);
                }
            }
            _ => {}
        }
    }

    Err("YouTube player response JSON is incomplete".to_string())
}

fn caption_tracks(player: &Value) -> Vec<&Value> {
    player
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(Value::as_array)
        .map(|tracks| tracks.iter().collect())
        .unwrap_or_default()
}

fn caption_track_at(player: &Value, index: usize) -> Option<&Value> {
    player
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(Value::as_array)
        .and_then(|tracks| tracks.get(index))
}

fn tracks_from_player(player: &Value) -> Vec<Value> {
    caption_tracks(player)
        .into_iter()
        .enumerate()
        .filter(|(_, track)| track.get("baseUrl").and_then(Value::as_str).is_some())
        .map(|(index, track)| track_json(index, track))
        .collect()
}

fn track_json(index: usize, track: &Value) -> Value {
    let kind = track
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let language_code = track
        .get("languageCode")
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "index": index,
        "languageCode": language_code,
        "label": track_name(track).unwrap_or_else(|| language_code.to_string()),
        "isAutoGenerated": kind == "asr",
    })
}

fn track_name(track: &Value) -> Option<String> {
    let value = track.get("name")?;
    if let Some(text) = value.get("simpleText").and_then(Value::as_str) {
        return Some(clean_text(text));
    }
    let text = value
        .get("runs")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|run| run.get("text").and_then(Value::as_str))
        .collect::<String>();
    let text = clean_text(&text);
    (!text.is_empty()).then_some(text)
}

fn thumbnail_url(player: &Value) -> Option<String> {
    player
        .pointer("/videoDetails/thumbnail/thumbnails")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|thumb| {
            let url = thumb.get("url").and_then(Value::as_str)?;
            let width = thumb.get("width").and_then(Value::as_u64).unwrap_or(0);
            let height = thumb.get("height").and_then(Value::as_u64).unwrap_or(0);
            Some((width * height, url.to_string()))
        })
        .max_by_key(|(area, _)| *area)
        .map(|(_, url)| url)
}

fn format_caption_url(base_url: &str) -> String {
    if let Ok(mut url) = Url::parse(base_url) {
        let pairs = url
            .query_pairs()
            .filter(|(key, _)| key != "fmt")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        {
            let mut query = url.query_pairs_mut();
            for (key, value) in pairs {
                query.append_pair(&key, &value);
            }
            query.append_pair("fmt", "vtt");
        }
        return url.to_string();
    }
    let separator = if base_url.contains('?') { '&' } else { '?' };
    format!("{base_url}{separator}fmt=vtt")
}

fn caption_body_to_text(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim_start();
    if trimmed.starts_with("<?xml") || trimmed.starts_with("<transcript") {
        return xml_caption_to_text(raw);
    }
    Ok(subtitles::parse_vtt(raw))
}

fn xml_caption_to_text(raw: &str) -> Result<String, String> {
    let doc = roxmltree::Document::parse(raw).map_err(|e| e.to_string())?;
    let lines = doc
        .descendants()
        .filter(|node| node.has_tag_name("text"))
        .filter_map(|node| node.text())
        .map(|text| html_escape::decode_html_entities(text).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(subtitles::parse_vtt(&lines))
}

fn clean_text(value: &str) -> String {
    html_escape::decode_html_entities(value).trim().to_string()
}

#[cfg(test)]
#[path = "tests/youtube_captions/tests.rs"]
mod tests;
