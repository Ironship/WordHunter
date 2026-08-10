use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
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

fn wait_with_output_timeout(mut child: Child, timeout: Duration) -> Result<Output, String> {
    // Drain both pipes while the child is running. Waiting first can deadlock
    // once either OS pipe buffer fills.
    let stdout_thread = child.stdout.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            use std::io::Read;
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    });
    let stderr_thread = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            use std::io::Read;
            let _ = pipe.read_to_end(&mut buffer);
            buffer
        })
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "ebook-convert timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.to_string());
            }
        }
    };

    let stdout = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    Ok(Output {
        status: status?,
        stdout,
        stderr,
    })
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

    let output = wait_with_output_timeout(
        command.spawn().map_err(|error| error.to_string())?,
        Duration::from_secs(180),
    )?;

    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr_text.is_empty() {
            stdout_text
        } else {
            stderr_text
        });
    }

    let text = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(clean_imported_ebook_text(&decode_epub_text(&text)))
}

#[cfg(test)]
mod tests {
    use super::wait_with_output_timeout;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn drains_large_stdout_and_stderr_without_deadlocking() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args([
                "/d",
                "/s",
                "/c",
                "(for /L %i in (1,1,5000) do @echo 012345678901234567890123456789)&(for /L %i in (1,1,5000) do @echo abcdefghijklmnopqrstuvwxyz 1>&2)",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "yes 012345678901234567890123456789 | head -c 160000; yes abcdefghijklmnopqrstuvwxyz | head -c 160000 >&2",
            ]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = wait_with_output_timeout(command.spawn().unwrap(), Duration::from_secs(10))
            .expect("large piped output should be drained before the child exits");

        assert!(output.status.success());
        assert!(output.stdout.len() > 64 * 1024);
        assert!(output.stderr.len() > 64 * 1024);
    }
}
