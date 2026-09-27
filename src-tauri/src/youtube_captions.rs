use serde_json::{Value, json};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
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

/// The download op answers within this time, below the frontend's request
/// timeout: the watch page, the direct caption request and every yt-dlp try
/// share it.
const DOWNLOAD_BUDGET: Duration = Duration::from_secs(110);
/// Listing tracks through yt-dlp when the watch page has none.
const LIST_BUDGET: Duration = Duration::from_secs(60);

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
            let (info, tracks) = video_tracks(url, Instant::now() + LIST_BUDGET)?;
            Ok(json!({
                "videoId": info.id,
                "title": info.title,
                "author": info.author,
                "thumbnailUrl": info.thumbnail_url,
                "sourceUrl": watch_url(&info.id),
                "tracks": tracks
                    .iter()
                    .enumerate()
                    .map(|(index, track)| track_json(index, track))
                    .collect::<Vec<_>>(),
            }))
        }
        "download" => {
            let deadline = Instant::now() + DOWNLOAD_BUDGET;
            let track_index = payload
                .get("track_index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing track_index".to_string())?
                as usize;
            // The same resolution as "tracks", so an index means the same track.
            let (info, tracks) = video_tracks(url, deadline)?;
            let track = tracks
                .get(track_index)
                .ok_or_else(|| "caption track not found".to_string())?;
            let text = download_caption_text(&info, track, deadline)?;
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

/// The video and its caption tracks: from the watch page, or, when the page
/// does not list any (consent or bot-check pages), from `yt-dlp -J`.
fn video_tracks(url: &str, deadline: Instant) -> Result<(VideoInfo, Vec<Value>), String> {
    let id = video_id_from_url(url)?;
    let scraped = fetch_video_info(&id).map(|info| {
        let tracks = page_tracks(&info.player);
        (info, tracks)
    });
    let page_error = match scraped {
        Ok((info, tracks)) if !tracks.is_empty() => return Ok((info, tracks)),
        Ok(_) => "the watch page lists no captions".to_string(),
        Err(error) => error,
    };
    match ytdlp_video_tracks(&id, deadline) {
        Ok(Some(found)) => Ok(found),
        // No yt-dlp: report what the page said.
        Ok(None) => Err(page_error),
        Err(error) => Err(format!("{page_error}; yt-dlp: {error}")),
    }
}

fn ytdlp_video_tracks(
    id: &str,
    deadline: Instant,
) -> Result<Option<(VideoInfo, Vec<Value>)>, String> {
    let mut errors = Vec::new();
    for invocation in ytdlp_commands() {
        let args = ["-J", "--skip-download", "--no-playlist", "--no-warnings"]
            .map(OsString::from)
            .into_iter()
            .chain([OsString::from(watch_url(id))])
            .collect::<Vec<_>>();
        match run_ytdlp_process(&invocation, &args, deadline) {
            Ok((output, _temp)) => {
                let json = serde_json::from_slice::<Value>(&output.stdout)
                    .map_err(|e| format!("yt-dlp printed no video JSON: {e}"))?;
                return Ok(Some(tracks_from_ytdlp_json(id, &json)));
            }
            Err(YtdlpError::Missing(_)) => continue,
            Err(YtdlpError::TimedOut) => return Err(YtdlpError::TimedOut.to_string()),
            Err(error) => errors.push(format!("{}: {error}", invocation.program.to_string_lossy())),
        }
    }
    if errors.is_empty() {
        Ok(None)
    } else {
        Err(errors.join("; "))
    }
}

/// Video details and caption tracks from `yt-dlp -J` output: manual tracks
/// first, then automatic ones (marked like the page's "asr" tracks), each
/// group sorted by language.
fn tracks_from_ytdlp_json(id: &str, json: &Value) -> (VideoInfo, Vec<Value>) {
    let group = |key: &str, kind: &str| {
        let mut tracks = json
            .get(key)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(language, formats)| {
                // yt-dlp lists translated automatic captions as "de-en"; the
                // original tracks are the ones without a source suffix.
                !language.is_empty()
                    && formats
                        .as_array()
                        .is_some_and(|formats| !formats.is_empty())
                    && (kind != "asr" || !language.contains('-'))
            })
            .map(|(language, formats)| {
                let name = formats
                    .as_array()
                    .and_then(|formats| formats.iter().find_map(|format| format.get("name")))
                    .and_then(Value::as_str)
                    .unwrap_or(language);
                json!({
                    "languageCode": language,
                    "kind": kind,
                    "name": { "simpleText": name },
                })
            })
            .collect::<Vec<_>>();
        tracks.sort_by(|a, b| a["languageCode"].as_str().cmp(&b["languageCode"].as_str()));
        tracks
    };
    let mut tracks = group("subtitles", "manual");
    tracks.extend(group("automatic_captions", "asr"));
    let text = |key: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default()
    };
    let title = Some(text("title"))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "YouTube video".to_string());
    let thumbnail_url = Some(text("thumbnail"))
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
    let info = VideoInfo {
        id: id.to_string(),
        title,
        author: text("uploader"),
        thumbnail_url,
        player: Value::Null,
    };
    (info, tracks)
}

fn download_caption_text(
    info: &VideoInfo,
    track: &Value,
    deadline: Instant,
) -> Result<String, String> {
    // Tracks listed by yt-dlp have no page URL; yt-dlp downloads them too.
    let direct_error = if track.get("baseUrl").is_some() {
        match download_caption_text_direct(track) {
            Ok(text) if !text.trim().is_empty() => return Ok(text),
            Ok(_) => "caption track is empty".to_string(),
            Err(err) => err,
        }
    } else {
        "the track is only available through yt-dlp".to_string()
    };
    download_caption_text_with_ytdlp(info, track, deadline).map_err(|fallback_error| {
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

fn download_caption_text_with_ytdlp(
    info: &VideoInfo,
    track: &Value,
    deadline: Instant,
) -> Result<String, String> {
    let language = ytdlp_track_language(track)
        .ok_or_else(|| "caption track has no language code".to_string())?;
    let mut errors = Vec::new();
    for invocation in ytdlp_commands() {
        match run_ytdlp(&invocation, info, track, &language, deadline) {
            Ok(text) => return Ok(text),
            Err(YtdlpError::Missing(_)) => continue,
            // The shared time is used up; later candidates would not get any.
            Err(YtdlpError::TimedOut) => {
                errors.push(YtdlpError::TimedOut.to_string());
                break;
            }
            Err(err) => errors.push(format!("{}: {err}", invocation.program.to_string_lossy())),
        }
    }

    if errors.is_empty() {
        return Err("yt-dlp was not found; install yt-dlp or set WORDHUNTER_YTDLP".to_string());
    }
    Err(errors.join("; "))
}

/// A way to invoke yt-dlp: the program to spawn, extra arguments inserted
/// before the yt-dlp arguments (e.g. the host Python interpreter when the
/// host yt-dlp is a python script), and environment overrides pointing at
/// the host's python packages and libraries.
#[derive(Clone)]
struct YtdlpInvocation {
    program: OsString,
    prefix_args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

fn plain_ytdlp(program: OsString) -> YtdlpInvocation {
    YtdlpInvocation {
        program,
        prefix_args: Vec::new(),
        env: Vec::new(),
    }
}

#[derive(Debug)]
enum YtdlpError {
    /// This candidate is not installed; the next one may be.
    Missing(String),
    TimedOut,
    Failed(String),
}

impl std::fmt::Display for YtdlpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(error) => write!(f, "Could not start yt-dlp: {error}"),
            Self::TimedOut => write!(f, "yt-dlp ran out of time"),
            Self::Failed(error) => write!(f, "{error}"),
        }
    }
}

fn run_ytdlp(
    invocation: &YtdlpInvocation,
    info: &VideoInfo,
    track: &Value,
    language: &str,
    deadline: Instant,
) -> Result<String, YtdlpError> {
    let temp = tempfile::tempdir().map_err(|e| YtdlpError::Failed(e.to_string()))?;
    let output_template = temp.path().join("%(id)s.%(ext)s");
    let args = [
        "--skip-download",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        if track_is_auto_generated(track) {
            "--write-auto-subs"
        } else {
            "--write-subs"
        },
        "--sub-langs",
        language,
        "--sub-format",
        "vtt",
        "-o",
    ]
    .map(OsString::from)
    .into_iter()
    .chain([
        output_template.into_os_string(),
        OsString::from(watch_url(&info.id)),
    ])
    .collect::<Vec<_>>();
    let (_output, work) = run_ytdlp_process(invocation, &args, deadline)?;
    let path = find_subtitle_file(temp.path())
        .and_then(|found| match found {
            Some(path) => Ok(Some(path)),
            None => find_subtitle_file(work.path()),
        })
        .map_err(YtdlpError::Failed)?
        .ok_or_else(|| YtdlpError::Failed("yt-dlp did not write a subtitle file".to_string()))?;
    let raw = read_caption_file(&path).map_err(YtdlpError::Failed)?;
    let text = caption_body_to_text(&raw).map_err(YtdlpError::Failed)?;
    if text.trim().is_empty() {
        return Err(YtdlpError::Failed(
            "yt-dlp returned empty captions".to_string(),
        ));
    }
    Ok(text)
}

/// Runs yt-dlp with `args` until `deadline`; returns its output and the
/// directory that holds its captured messages.
fn run_ytdlp_process(
    invocation: &YtdlpInvocation,
    args: &[OsString],
    deadline: Instant,
) -> Result<(Output, tempfile::TempDir), YtdlpError> {
    if Instant::now() >= deadline {
        return Err(YtdlpError::TimedOut);
    }
    let work = tempfile::tempdir().map_err(|e| YtdlpError::Failed(e.to_string()))?;
    let mut process = Command::new(&invocation.program);
    process
        .args(&invocation.prefix_args)
        .envs(invocation.env.iter().cloned())
        .args(args);
    // Never pop a visible console window on Windows when spawning yt-dlp
    // from the embedded server (CREATE_NO_WINDOW = 0x08000000).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    // Capture yt-dlp's messages (its ERROR line says why it failed) in files:
    // inherited stdio loses them, and pipes could fill up while we poll.
    let stdout_path = work.path().join("yt-dlp.out.log");
    let stderr_path = work.path().join("yt-dlp.err.log");
    let stdout = fs::File::create(&stdout_path).map_err(|e| YtdlpError::Failed(e.to_string()))?;
    let stderr = fs::File::create(&stderr_path).map_err(|e| YtdlpError::Failed(e.to_string()))?;
    process
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    let mut child = process.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            YtdlpError::Missing(e.to_string())
        } else {
            YtdlpError::Failed(format!("Could not start yt-dlp: {e}"))
        }
    })?;
    let output = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break Output {
                    status,
                    stdout: fs::read(&stdout_path).unwrap_or_default(),
                    stderr: fs::read(&stderr_path).unwrap_or_default(),
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(YtdlpError::TimedOut);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                return Err(YtdlpError::Failed(format!(
                    "Could not wait for yt-dlp: {e}"
                )));
            }
        }
    };
    if !output.status.success() {
        return Err(YtdlpError::Failed(process_error(&output)));
    }
    Ok((output, work))
}

fn ytdlp_commands() -> Vec<YtdlpInvocation> {
    let mut commands = Vec::new();
    if let Some(value) = env::var_os("WORDHUNTER_YTDLP").filter(|value| !value.is_empty()) {
        commands.push(plain_ytdlp(value));
    }
    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        for name in ytdlp_names() {
            commands.push(plain_ytdlp(dir.join(name).into_os_string()));
            commands.push(plain_ytdlp(dir.join("bin").join(name).into_os_string()));
        }
    }
    // Flatpak exposes the host read-only under /run/host and snapd binds
    // the host root at /var/lib/snapd/hostfs. The host's yt-dlp is a python
    // script whose shebang resolves to the sandbox interpreter, so run it
    // through the host python with the host's dist-packages and libraries
    // (same pattern as the OCR runner's pdftoppm host fallback).
    #[cfg(target_os = "linux")]
    for prefix in [Path::new("/run/host"), Path::new("/var/lib/snapd/hostfs")] {
        if prefix.join("usr").join("bin").join("yt-dlp").is_file() {
            commands.extend(host_ytdlp_invocations(prefix));
        }
    }
    for name in ytdlp_names() {
        commands.push(plain_ytdlp(OsString::from(name)));
    }
    dedupe_invocations(commands)
}

/// Invocations for a host `yt-dlp` script visible at `prefix/usr/bin`:
/// first through the host python interpreter with the host's module and
/// library paths, then the bare script as a last resort.
#[cfg(any(target_os = "linux", test))]
fn host_ytdlp_invocations(prefix: &Path) -> Vec<YtdlpInvocation> {
    let script = prefix.join("usr").join("bin").join("yt-dlp");
    vec![
        YtdlpInvocation {
            program: prefix
                .join("usr")
                .join("bin")
                .join("python3")
                .into_os_string(),
            prefix_args: vec![script.clone().into_os_string()],
            env: host_python_env(prefix),
        },
        plain_ytdlp(script.into_os_string()),
    ]
}

/// Environment that lets the host python run host python scripts: the
/// host's dist-packages on PYTHONPATH and the host's libraries on
/// LD_LIBRARY_PATH, preserving sandbox values.
#[cfg(any(target_os = "linux", test))]
fn host_python_env(prefix: &Path) -> Vec<(OsString, OsString)> {
    vec![
        (
            OsString::from("PYTHONPATH"),
            crate::host_paths::prepend_path_var(
                "PYTHONPATH",
                prefix
                    .join("usr")
                    .join("lib")
                    .join("python3")
                    .join("dist-packages"),
            ),
        ),
        (
            OsString::from("LD_LIBRARY_PATH"),
            crate::host_paths::host_library_path_for(prefix).into(),
        ),
    ]
}

fn ytdlp_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["yt-dlp.exe", "yt-dlp"]
    } else {
        &["yt-dlp"]
    }
}

fn dedupe_invocations(values: Vec<YtdlpInvocation>) -> Vec<YtdlpInvocation> {
    let mut deduped = Vec::new();
    for value in values {
        let duplicate = deduped.iter().any(|existing: &YtdlpInvocation| {
            existing.program == value.program && existing.prefix_args == value.prefix_args
        });
        if !duplicate {
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

fn fetch_video_info(id: &str) -> Result<VideoInfo, String> {
    let id = id.to_string();
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
        // SOCS is the consent cookie YouTube checks today (yt-dlp sends the
        // same); CONSENT is its older form.
        .set("Cookie", "CONSENT=YES+1; SOCS=CAI")
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

/// The page's caption tracks that can be fetched directly, in page order.
fn page_tracks(player: &Value) -> Vec<Value> {
    caption_tracks(player)
        .into_iter()
        .filter(|track| track.get("baseUrl").and_then(Value::as_str).is_some())
        .cloned()
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
