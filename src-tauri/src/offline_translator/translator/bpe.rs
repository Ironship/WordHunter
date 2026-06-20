use std::collections::HashMap;
use std::fs;
use std::path::Path;

use regex::Regex;

/// A BPE tokenizer that reads merge codes from a `bpe.model` file
/// and implements the `ctranslate2::Tokenizer` trait.
pub(crate) struct BpeTokenizer {
    codes: HashMap<(String, String), usize>,
    version: (u8, u8),
    token_regex: Regex,
}

impl BpeTokenizer {
    /// Load a BPE model from a directory containing `bpe.model`.
    pub fn from_model_dir(model_dir: &Path) -> Result<Self, String> {
        let bpe = fs::read_to_string(model_dir.join("bpe.model")).map_err(|e| e.to_string())?;
        let mut version = (0, 1);
        let mut codes = HashMap::new();
        for (line_index, raw) in bpe.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            if line_index == 0 && line.starts_with("#version:") {
                let parsed = line
                    .split_whitespace()
                    .last()
                    .and_then(parse_bpe_version)
                    .unwrap_or((0, 2));
                version = parsed;
                continue;
            }
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() == 2 {
                let rank = codes.len();
                codes
                    .entry((parts[0].to_string(), parts[1].to_string()))
                    .or_insert(rank);
            }
        }
        Ok(Self {
            codes,
            version,
            token_regex: Regex::new(r"&apos;[\p{L}]+|&apos;|&quot;|&amp;|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]")
                .map_err(|e| e.to_string())?,
        })
    }

    /// Split input text into pre-tokens (words / symbols).
    fn tokenize(&self, input: &str) -> Vec<String> {
        let normalized = input
            .replace(['’', '‘'], "'")
            .replace(['“', '”'], "\"")
            .replace("&", "&amp;")
            .replace("\"", " &quot; ")
            .replace("'", " &apos;");
        self.token_regex
            .find_iter(&normalized)
            .map(|m| m.as_str().to_string())
            .collect()
    }

    /// Encode a single word into BPE sub-word pieces using the merge codes.
    fn encode_word(&self, word: &str) -> Vec<String> {
        if word.is_empty() {
            return Vec::new();
        }
        let chars = word.chars().map(|c| c.to_string()).collect::<Vec<_>>();
        let mut pieces = match self.version {
            (0, 2) => {
                let mut pieces = Vec::new();
                if chars.len() > 1 {
                    pieces.extend_from_slice(&chars[..chars.len() - 1]);
                }
                let last = chars.last().cloned().unwrap_or_default();
                pieces.push(format!("{last}</w>"));
                pieces
            }
            _ => {
                let mut pieces = chars;
                pieces.push("</w>".to_string());
                pieces
            }
        };

        while pieces.len() > 1 {
            let Some((best_index, _)) = pieces
                .windows(2)
                .enumerate()
                .filter_map(|(index, pair)| {
                    self.codes
                        .get(&(pair[0].clone(), pair[1].clone()))
                        .map(|rank| (index, *rank))
                })
                .min_by_key(|(_, rank)| *rank)
            else {
                break;
            };
            let pair = (pieces[best_index].clone(), pieces[best_index + 1].clone());
            let mut merged = Vec::with_capacity(pieces.len() - 1);
            let mut index = 0;
            while index < pieces.len() {
                if index + 1 < pieces.len()
                    && pieces[index] == pair.0
                    && pieces[index + 1] == pair.1
                {
                    merged.push(format!("{}{}", pieces[index], pieces[index + 1]));
                    index += 2;
                } else {
                    merged.push(pieces[index].clone());
                    index += 1;
                }
            }
            pieces = merged;
        }

        if let Some(last) = pieces.last_mut() {
            if last == "</w>" {
                pieces.pop();
            } else if last.ends_with("</w>") {
                *last = last.trim_end_matches("</w>").to_string();
            }
        }
        pieces
    }

    /// Decode a sequence of BPE tokens back into readable text.
    fn detokenize(&self, tokens: &[String]) -> String {
        let mut text = tokens
            .iter()
            .take_while(|token| token.as_str() != "</s>")
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("@@ ", "")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&");
        for (pattern, replacement) in [
            (r"\s+([,.;:!?%\)\]\}])", "$1"),
            (r"([\(\[\{])\s+", "$1"),
            (r#"\s+(["'])"#, "$1"),
            (r#"(["'])\s+"#, "$1"),
            (r"\s+", " "),
        ] {
            if let Ok(regex) = Regex::new(pattern) {
                text = regex.replace_all(&text, replacement).to_string();
            }
        }
        text.trim().to_string()
    }
}

impl ctranslate2::Tokenizer for BpeTokenizer {
    fn encode(&self, input: &str) -> anyhow::Result<Vec<String>> {
        let mut output = Vec::new();
        for token in self.tokenize(input) {
            let pieces = self.encode_word(&token);
            if let Some((last, rest)) = pieces.split_last() {
                for piece in rest {
                    output.push(format!("{piece}@@"));
                }
                output.push(last.clone());
            }
        }
        Ok(output)
    }

    fn decode(&self, tokens: Vec<String>) -> anyhow::Result<String> {
        Ok(self.detokenize(&tokens))
    }
}

/// Parse a "major.minor" version string.
fn parse_bpe_version(value: &str) -> Option<(u8, u8)> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor))
}
