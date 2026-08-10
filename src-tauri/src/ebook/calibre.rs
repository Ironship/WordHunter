use std::ffi::OsString;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use std::{fs, thread};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tempfile::TempDir;

use super::text::{clean_imported_ebook_text, decode_epub_text};

/// A way to invoke `ebook-convert`: the program to spawn, extra arguments
/// inserted before the converter arguments (e.g. the host Python
/// interpreter when the converter is a Flatpak/snap host script), and
/// environment overrides pointing at the host's Calibre install.
struct Converter {
    path: PathBuf,
    prefix_args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

fn plain_converter(path: PathBuf) -> Converter {
    Converter {
        path,
        prefix_args: Vec::new(),
        env: Vec::new(),
    }
}

fn find_ebook_convert() -> Option<Converter> {
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(if cfg!(windows) {
                "ebook-convert.exe"
            } else {
                "ebook-convert"
            });
            if candidate.is_file() {
                return Some(plain_converter(candidate));
            }
        }
    }

    // Flatpak: the sandbox cannot reach the host's Calibre install through
    // PATH; /run/host/usr/bin is the documented escape hatch.
    #[cfg(target_os = "linux")]
    {
        let prefix = Path::new("/run/host");
        if prefix
            .join("usr")
            .join("bin")
            .join("ebook-convert")
            .is_file()
        {
            for converter in host_ebook_convert_candidates(prefix) {
                if converter.path.is_file() {
                    return Some(converter);
                }
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
                    return Some(plain_converter(candidate));
                }
            }
        }
    }

    None
}

/// The host's `ebook-convert` is a python script (`#! /usr/bin/python3.13`)
/// that resolves its module path from `CALIBRE_PYTHON_PATH` and its
/// resources from `CALIBRE_RESOURCES_PATH`, defaulting to paths inside the
/// sandbox. Running it through the host interpreter with the host's
/// dist-packages and libraries is what makes a host Calibre install usable
/// from Flatpak. The final candidate is the bare script, which only works
/// when the sandbox interpreter happens to satisfy the shebang.
#[cfg(any(target_os = "linux", test))]
fn host_ebook_convert_candidates(prefix: &Path) -> Vec<Converter> {
    let script = prefix.join("usr").join("bin").join("ebook-convert");
    ["python3.13", "python3"]
        .iter()
        .map(|python| Converter {
            path: prefix.join("usr/bin").join(python),
            prefix_args: vec![script.clone().into_os_string()],
            env: host_calibre_env(prefix, python),
        })
        .chain(std::iter::once(plain_converter(script.clone())))
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn host_calibre_env(prefix: &Path, python: &str) -> Vec<(OsString, OsString)> {
    vec![
        (
            OsString::from("CALIBRE_PYTHON_PATH"),
            prefix
                .join("usr")
                .join("lib")
                .join("calibre")
                .into_os_string(),
        ),
        (
            OsString::from("CALIBRE_RESOURCES_PATH"),
            prefix
                .join("usr")
                .join("share")
                .join("calibre")
                .into_os_string(),
        ),
        (
            OsString::from("CALIBRE_EXTENSIONS_PATH"),
            prefix
                .join("usr")
                .join("lib")
                .join("calibre")
                .join("calibre")
                .join("plugins")
                .into_os_string(),
        ),
        (
            OsString::from("CALIBRE_EXECUTABLES_PATH"),
            prefix.join("usr/bin").into_os_string(),
        ),
        (
            OsString::from("PYTHONPATH"),
            crate::host_paths::prepend_path_var(
                "PYTHONPATH",
                prefix.join("usr/lib").join(python).join("dist-packages"),
            ),
        ),
        (
            OsString::from("LD_LIBRARY_PATH"),
            crate::host_paths::host_library_path_for(prefix).into(),
        ),
    ]
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

    let mut command = Command::new(&converter.path);
    command
        .args(&converter.prefix_args)
        .envs(converter.env.iter().cloned())
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
    use super::*;
    use std::collections::HashMap;
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

    #[test]
    fn host_calibre_env_points_into_the_host_prefix() {
        let env = host_calibre_env(Path::new("/run/host"), "python3.13");
        let map: HashMap<_, _> = env
            .iter()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect();

        assert_eq!(
            map["CALIBRE_PYTHON_PATH"].replace('\\', "/"),
            "/run/host/usr/lib/calibre"
        );
        assert_eq!(
            map["CALIBRE_RESOURCES_PATH"].replace('\\', "/"),
            "/run/host/usr/share/calibre"
        );
        assert_eq!(
            map["CALIBRE_EXTENSIONS_PATH"].replace('\\', "/"),
            "/run/host/usr/lib/calibre/calibre/plugins"
        );
        assert_eq!(
            map["CALIBRE_EXECUTABLES_PATH"].replace('\\', "/"),
            "/run/host/usr/bin"
        );
        assert!(
            map["PYTHONPATH"]
                .replace('\\', "/")
                .starts_with("/run/host/usr/lib/python3.13/dist-packages"),
            "PYTHONPATH was {}",
            map["PYTHONPATH"]
        );
        assert!(
            map["LD_LIBRARY_PATH"]
                .replace('\\', "/")
                .contains("/run/host/usr/lib/x86_64-linux-gnu"),
            "LD_LIBRARY_PATH was {}",
            map["LD_LIBRARY_PATH"]
        );
    }

    #[test]
    fn host_ebook_convert_candidates_prefer_the_host_interpreter() {
        let temp = tempfile::tempdir().unwrap();
        let prefix = temp.path();
        let bin = prefix.join("usr").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("python3.13"), "").unwrap();
        fs::write(bin.join("python3"), "").unwrap();
        fs::write(bin.join("ebook-convert"), "").unwrap();

        let candidates = host_ebook_convert_candidates(prefix);
        assert_eq!(candidates.len(), 3);

        let wrapped = &candidates[0];
        assert_eq!(wrapped.path, bin.join("python3.13"));
        assert_eq!(
            wrapped.prefix_args,
            vec![bin.join("ebook-convert").into_os_string()]
        );
        assert!(!wrapped.env.is_empty());

        let wrapped_python3 = &candidates[1];
        assert_eq!(wrapped_python3.path, bin.join("python3"));
        assert_eq!(
            wrapped_python3.prefix_args,
            vec![bin.join("ebook-convert").into_os_string()]
        );

        let bare = &candidates[2];
        assert_eq!(bare.path, bin.join("ebook-convert"));
        assert!(bare.prefix_args.is_empty());
        assert!(bare.env.is_empty());
    }

    #[test]
    fn find_ebook_convert_prefers_the_host_interpreter_when_the_script_exists() {
        let temp = tempfile::tempdir().unwrap();
        let prefix = temp.path();
        let bin = prefix.join("usr").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("python3.13"), "").unwrap();
        fs::write(bin.join("ebook-convert"), "").unwrap();

        // The /run/host probe is hardcoded, so exercise the same selection
        // logic the flatpak branch uses: the first candidate whose program
        // exists wins.
        let candidates = host_ebook_convert_candidates(prefix);
        let selected = candidates
            .iter()
            .find(|candidate| candidate.path.is_file())
            .expect("at least the bare script exists");
        assert_eq!(selected.path, bin.join("python3.13"));
    }
}
