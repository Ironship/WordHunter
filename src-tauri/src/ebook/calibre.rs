use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{fs, thread};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tempfile::TempDir;

use super::text::{clean_imported_ebook_text, decode_epub_text};

fn find_ebook_convert() -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(if cfg!(windows) {
                "ebook-convert.exe"
            } else {
                "ebook-convert"
            });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(windows)]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(key) {
                let candidate = PathBuf::from(base)
                    .join("Calibre2")
                    .join("ebook-convert.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

pub(crate) fn convert_with_calibre(data: &[u8], suffix: &str) -> Result<String, String> {
    let converter = find_ebook_convert()
        .ok_or_else(|| "MOBI/AZW import requires Calibre and ebook-convert in PATH".to_string())?;
    let temp = TempDir::new().map_err(|e| e.to_string())?;
    let source = temp.path().join(format!("input{suffix}"));
    let target = temp.path().join("output.txt");
    fs::write(&source, data).map_err(|e| e.to_string())?;

    let mut command = Command::new(converter);
    command
        .arg(&source)
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ebook-convert timed out after 180 seconds".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_end(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        use std::io::Read;
        let _ = err.read_to_end(&mut stderr);
    }

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
        let stdout_text = String::from_utf8_lossy(&stdout).trim().to_string();
        return Err(if stderr_text.is_empty() {
            stdout_text
        } else {
            stderr_text
        });
    }

    let text = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(clean_imported_ebook_text(&decode_epub_text(&text)))
}
