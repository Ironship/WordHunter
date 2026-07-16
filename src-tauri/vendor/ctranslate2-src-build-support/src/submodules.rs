use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
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

fn github_get(url: &str) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    let mut request = ureq::get(url)
        .header("User-Agent", "rust-submodule-fetcher")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");

    if let Some(token) = ["GITHUB_TOKEN", "GH_TOKEN"]
        .into_iter()
        .find_map(|name| env::var(name).ok())
        .filter(|token| !token.trim().is_empty())
    {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    request.call()
}

fn parse_gitmodules(gitmodules: &str) -> HashMap<String, String> {
    let mut path_to_url = HashMap::new();
    let mut current_path = String::new();
    for line in gitmodules.lines() {
        if line.trim().starts_with("[submodule") {
            current_path.clear();
        } else if let Some(rest) = line.trim().strip_prefix("path = ") {
            current_path = rest.to_string();
        } else if let Some(rest) = line.trim().strip_prefix("url = ") {
            path_to_url.insert(current_path.clone(), rest.to_string());
        }
    }
    path_to_url
}

fn parse_gitlinks(
    tree: &str,
    path_to_url: &HashMap<String, String>,
) -> Vec<(String, String, String)> {
    tree.lines()
        .filter_map(|line| {
            let (metadata, path) = line.split_once('\t')?;
            let mut fields = metadata.split_whitespace();
            if fields.next()? != "160000" || fields.next()? != "commit" {
                return None;
            }
            let sha = fields.next()?.to_string();
            let url = path_to_url.get(path).cloned().unwrap_or_default();
            Some((path.to_string(), sha, url))
        })
        .collect()
}

fn get_submodules_via_git(
    parent: &Path,
    version: &str,
) -> Result<Vec<(String, String, String)>, Box<dyn std::error::Error>> {
    let source_dir = parent.join(format!("CTranslate2-{version}"));
    let path_to_url = parse_gitmodules(&fs::read_to_string(source_dir.join(".gitmodules"))?);
    let metadata_dir = parent.join(format!(".CTranslate2-{version}-git"));
    if metadata_dir.exists() {
        fs::remove_dir_all(&metadata_dir)?;
    }

    let tag = format!("v{version}");
    let status = Command::new("git")
        .args([
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--depth",
            "1",
            "--branch",
            &tag,
            "https://github.com/OpenNMT/CTranslate2.git",
            metadata_dir.to_str().unwrap(),
        ])
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "git metadata clone failed with {status}"
        ))
        .into());
    }

    let output = Command::new("git")
        .current_dir(&metadata_dir)
        .args(["ls-tree", "-r", "HEAD"])
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "git ls-tree failed with {}",
            output.status
        ))
        .into());
    }
    let modules = parse_gitlinks(&String::from_utf8(output.stdout)?, &path_to_url);
    fs::remove_dir_all(metadata_dir)?;
    if modules.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "CTranslate2 tag did not contain any submodule gitlinks",
        )
        .into());
    }
    Ok(modules)
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
        let resp = github_get(&ref_url)?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };
    let commit_sha = git_ref.object.sha;

    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        owner, repo, commit_sha
    );
    let tree: Tree = {
        let resp = github_get(&tree_url)?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };

    let gitmodules_url = format!(
        "https://api.github.com/repos/{}/{}/contents/.gitmodules?ref={}",
        owner, repo, tag
    );
    let gitmodules_file: GitModuleFile = {
        let resp = github_get(&gitmodules_url)?;
        serde_json::from_reader(BufReader::new(resp.into_body().into_reader()))?
    };

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(gitmodules_file.content.replace("\n", ""))?;
    let gitmodules_str = String::from_utf8(decoded)?;

    let path_to_url = parse_gitmodules(&gitmodules_str);

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
    let submodules = match get_submodules("OpenNMT", "CTranslate2", &format!("v{version}")) {
        Ok(submodules) => submodules,
        Err(error) => {
            eprintln!(
                "GitHub API submodule lookup failed ({error}); falling back to Git metadata"
            );
            get_submodules_via_git(path, version).unwrap_or_else(|git_error| {
                panic!(
                    "failed to resolve CTranslate2 submodules through GitHub API ({error}) and Git ({git_error})"
                )
            })
        }
    };
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

#[cfg(test)]
mod tests {
    use super::{parse_gitlinks, parse_gitmodules};

    #[test]
    fn parses_submodule_urls_and_gitlinks() {
        let urls = parse_gitmodules(
            r#"
[submodule "third_party/example"]
    path = third_party/example
    url = https://github.com/example/example.git
"#,
        );
        let modules = parse_gitlinks(
            "160000 commit abc123\tthird_party/example\n100644 blob def456\tREADME.md\n",
            &urls,
        );

        assert_eq!(
            modules,
            vec![(
                "third_party/example".to_string(),
                "abc123".to_string(),
                "https://github.com/example/example.git".to_string()
            )]
        );
    }
}
