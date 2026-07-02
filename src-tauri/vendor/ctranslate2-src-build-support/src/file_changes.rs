use std::{fs, path::Path};

pub fn watch_dir_recursively(dir: &Path) {
    for entry in fs::read_dir(dir)
        .map(|v| v.collect::<Vec<_>>())
        .unwrap_or_default()
    {
        let entry = entry.expect("Failed to read entry");
        let path = entry.path();

        if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
        } else if path.is_dir() {
            watch_dir_recursively(&path);
        }
    }
}
