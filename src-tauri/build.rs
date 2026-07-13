use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap_or_else(|error| {
        panic!(
            "failed to read frontend source {}: {error}",
            directory.display()
        )
    }) {
        let path = entry.expect("failed to read frontend source entry").path();
        if path.is_dir() {
            collect_files(&path, files);
        } else {
            files.push(path);
        }
    }
}

fn frontend_source_hash(manifest_dir: &Path) -> String {
    let root = manifest_dir
        .parent()
        .expect("src-tauri must have a repository parent");
    let source_dir = root.join("src/web");
    let mut files = Vec::new();
    collect_files(&source_dir, &mut files);
    files.extend([
        root.join("tsconfig.json"),
        root.join("package-lock.json"),
        root.join("scripts/build-frontend.mjs"),
    ]);
    files.sort_by_key(|path| {
        path.strip_prefix(root)
            .expect("frontend input must be in repository")
            .to_string_lossy()
            .replace('\\', "/")
    });

    let mut hash = Sha256::new();
    for path in files {
        let relative = path
            .strip_prefix(root)
            .expect("frontend input must be in repository")
            .to_string_lossy()
            .replace('\\', "/");
        hash.update(relative.as_bytes());
        hash.update([0]);
        hash.update(fs::read(&path).unwrap_or_else(|error| {
            panic!("failed to read frontend input {}: {error}", path.display())
        }));
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"),
    );
    let stamp_path = manifest_dir.join("../dist/web/.wordhunter-build.sha256");
    let built_hash = fs::read_to_string(&stamp_path).unwrap_or_else(|_| {
        panic!("compiled frontend is missing; run `npm run build:frontend` before Cargo")
    });
    let source_hash = frontend_source_hash(&manifest_dir);
    assert_eq!(
        built_hash.trim(),
        source_hash,
        "compiled frontend is stale; run `npm run build:frontend` before Cargo"
    );

    println!("cargo:rerun-if-changed=../dist/web");
    println!("cargo:rerun-if-changed=../src/web");
    println!("cargo:rerun-if-changed=../tsconfig.json");
    println!("cargo:rerun-if-changed=../package-lock.json");
    println!("cargo:rerun-if-changed=../scripts/build-frontend.mjs");
    tauri_build::build()
}
