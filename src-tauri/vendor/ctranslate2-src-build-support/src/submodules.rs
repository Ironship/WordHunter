use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Deserialize)]
struct GitRef {
    object: GitObject,
}

#[derive(Debug, Deserialize)]
struct GitObject {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct Tree {
    tree: Vec<TreeEntry>,
}

#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    mode: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitModuleFile {
    content: String,
}

pub fn get_submodules(
    owner: &str,
    repo: &str,
    tag: &str,
) -> Result<Vec<(String, String, String)>, Box<dyn std::error::Error>> {
    let ref_url = format!(
        "https://api.github.com/repos/{}/{}/git/ref/tags/{}",
        owner, repo, tag
    );
    let git_ref: GitRef = {
        let resp = ureq::get(&ref_url)
            .header("User-Agent", "rust-submodule-fetcher")
            .call()?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };
    let commit_sha = git_ref.object.sha;

    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        owner, repo, commit_sha
    );
    let tree: Tree = {
        let resp = ureq::get(&tree_url)
            .header("User-Agent", "rust-submodule-fetcher")
            .call()?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };

    let gitmodules_url = format!(
        "https://api.github.com/repos/{}/{}/contents/.gitmodules?ref={}",
        owner, repo, tag
    );
    let gitmodules_file: GitModuleFile = {
        let resp = ureq::get(&gitmodules_url)
            .header("User-Agent", "rust-submodule-fetcher")
            .call()?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(gitmodules_file.content.replace("\n", ""))?;
    let gitmodules_str = String::from_utf8(decoded)?;

    let mut path_to_url = HashMap::new();
    let mut current_path = String::new();
    for line in gitmodules_str.lines() {
        if line.trim().starts_with("[submodule") {
            current_path.clear();
        } else if let Some(rest) = line.trim().strip_prefix("path = ") {
            current_path = rest.to_string();
        } else if let Some(rest) = line.trim().strip_prefix("url = ") {
            path_to_url.insert(current_path.clone(), rest.to_string());
        }
    }

    let submodules = tree
        .tree
        .into_iter()
        .filter(|entry| entry.mode == "160000") // gitlink indicates submodule
        .map(|entry| {
            let url = path_to_url.get(&entry.path).cloned().unwrap_or_default();
            (entry.path, entry.sha, url)
        })
        .collect();

    Ok(submodules)
}

pub fn get_submodules_helper(path: &Path, version: &str) -> Vec<PathBuf> {
    let p = path.join(format!("CTranslate2-{version}"));
    let f = p.join("submodules_downloaded");
    if f.exists() {
        return vec![];
    }
    let submodules = get_submodules("OpenNMT", "CTranslate2", &format!("v{version}")).unwrap();
    let mut modules = vec![];
    for (path, sha, url) in submodules {
        let submodule_path = p.join(path);
        modules.push(submodule_path.clone());
        let status = Command::new("git")
            .args([
                "clone",
                "--recurse-submodules",
                "--no-checkout",
                &url,
                submodule_path.to_str().unwrap(),
            ])
            .status()
            .expect("git clone failed");
        assert!(status.success());

        let status = Command::new("git")
            .current_dir(&submodule_path)
            .args(["checkout", &sha])
            .status()
            .expect("git checkout failed");
        assert!(status.success());
        let status = Command::new("git")
            .current_dir(&submodule_path)
            .args(["submodule", "update", "--init", "--recursive"])
            .status()
            .expect("git submodule update failed");
        assert!(status.success());
    }
    File::create(f).unwrap();
    modules
}
