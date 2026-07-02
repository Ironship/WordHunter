use std::{
    env,
    fs::File,
    path::{Path, PathBuf},
};

use flate2::Compression;
use tar::Builder;
use walkdir::WalkDir;

pub mod dnnl;
pub mod download;
pub mod file_changes;
pub mod native;
pub mod submodules;
pub mod windows_crt_patch;

#[derive(Debug, Eq, PartialEq, Copy, Clone)]
pub enum Os {
    Win,
    Mac,
    Linux,
    Unknown,
}

pub fn export(lib_path: &Path, modules: &[PathBuf], modules2: &[PathBuf]) {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let out_dir = out_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();

    let tar_gz = File::create(out_dir.join("vendored.tar.gz")).unwrap();
    let enc = flate2::write::GzEncoder::new(tar_gz, Compression::default());
    let mut tar = Builder::new(enc);

    tar.append_dir_all("include", lib_path.join("../include"))
        .unwrap();

    for module in modules {
        let mut file = File::open(&module).unwrap();
        let name = module.file_name().unwrap().to_str().unwrap();
        tar.append_file(format!("lib/{}", name), &mut file).unwrap();
    }
    for module in modules2 {
        let mut file = File::open(&module).unwrap();
        let name = module.file_name().unwrap().to_str().unwrap();
        tar.append_file(format!("dyn/{}", name), &mut file).unwrap();
    }

    tar.finish().unwrap();
}

pub fn link_libraries<T: AsRef<Path>>(root: T) -> Vec<PathBuf> {
    let mut current_dir = None;
    let mut libs = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() {
            if let Some(file_name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| is_library(name))
            {
                let parent = path.parent().unwrap();
                if Some(parent) != current_dir.as_deref() {
                    println!("cargo:rustc-link-search={}", parent.display());
                    current_dir = Some(parent.to_path_buf());
                }
                libs.push(path.to_path_buf());

                let lib_name = library_name(file_name);
                println!("cargo:rustc-link-lib=static={}", lib_name);
            }
        }
    }
    libs
}

#[cfg(not(target_os = "windows"))]
fn is_library(name: &&str) -> bool {
    name.starts_with("lib") && name.ends_with(".a")
}

#[cfg(not(target_os = "windows"))]
fn library_name(name: &str) -> &str {
    &name[3..name.len() - 2]
}

#[cfg(target_os = "windows")]
fn is_library(name: &&str) -> bool {
    name.ends_with(".lib") && !name.starts_with(".")
}

#[cfg(target_os = "windows")]
fn library_name(name: &str) -> &str {
    &name[0..name.len() - 4]
}

pub fn link_dynamic_libraries<T: AsRef<Path>>(root: T) -> Vec<PathBuf> {
    let mut current_dir = None;
    let mut libs = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() {
            if let Some(file_name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| is_dynamic_library(name))
            {
                let parent = path.parent().unwrap();
                if Some(parent) != current_dir.as_deref() {
                    println!("cargo:rustc-link-search={}", parent.display());
                    current_dir = Some(parent.to_path_buf());
                }
                libs.push(path.to_path_buf());

                let lib_name = dynamic_library_name(file_name);
                println!("cargo:rustc-link-lib=dylib={}", lib_name);
            }
        }
    }

    libs
}

#[cfg(target_os = "linux")]
fn is_dynamic_library(name: &str) -> bool {
    name.starts_with("lib") && name.ends_with(".so")
}

#[cfg(target_os = "linux")]
fn dynamic_library_name(name: &str) -> &str {
    &name[3..name.len() - 3] // remove "lib" prefix and ".so" suffix
}

#[cfg(target_os = "macos")]
fn is_dynamic_library(name: &str) -> bool {
    name.starts_with("lib") && name.ends_with(".dylib")
}

#[cfg(target_os = "macos")]
fn dynamic_library_name(name: &str) -> &str {
    &name[3..name.len() - 6] // remove "lib" prefix and ".dylib" suffix
}

#[cfg(target_os = "windows")]
fn is_dynamic_library(name: &str) -> bool {
    // On Windows, Cargo links to the .lib import library, but you can also detect .dll
    name.ends_with(".lib") && !name.starts_with(".")
}

#[cfg(target_os = "windows")]
fn dynamic_library_name(name: &str) -> &str {
    &name[0..name.len() - 4] // remove ".lib"
}
