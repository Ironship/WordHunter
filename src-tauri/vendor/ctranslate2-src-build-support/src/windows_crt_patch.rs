use std::fs;
use std::io;
use std::path::Path;

fn conditional_replace(content: &str, target_flag: &str) -> String {
    let mut result = String::new();
    let mut prev_line = "";

    for line in content.lines() {
        let mut new_line = line.to_string();
        if prev_line.contains("else()") {
            if line.contains("/MT") {
                new_line = line.replace("/MT", target_flag);
            } else if line.contains("/MD") {
                new_line = line.replace("/MD", target_flag);
            }
        }
        result.push_str(&new_line);
        result.push('\n');
        prev_line = line;
    }

    result
}

pub fn patch_cmake_runtime_flags<P: AsRef<Path>>(path: P, use_md: bool) -> io::Result<()> {
    let path = path.as_ref();
    let content = fs::read_to_string(path)?;

    let target_flag = if use_md { "/MD" } else { "/MT" };
    let multi_threaded_target = if use_md {
        "\"MultiThreaded$<$<CONFIG:Debug>:Debug>DLL\""
    } else {
        "\"MultiThreaded$<$<CONFIG:Debug>:Debug>\""
    };
    let mut new_content = conditional_replace(&content, target_flag);

    new_content = new_content.replace(
        "\"MultiThreaded$<$<CONFIG:Debug>:Debug>DLL\"",
        multi_threaded_target,
    );
    new_content = new_content.replace(
        "\"MultiThreaded$<$<CONFIG:Debug>:Debug>\"",
        multi_threaded_target,
    );

    if new_content != content {
        fs::write(path, new_content)?;
    }

    Ok(())
}
