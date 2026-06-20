use std::path::Path;

use anyhow::{Error, Result};
use sentencepiece::SentencePieceProcessor;

pub struct Tokenizer {
    enc: SentencePieceProcessor,
    dec: SentencePieceProcessor,
}

impl Tokenizer {
    /// Create a tokenizer instance by specifying the path to a directory containing `source.spm`
    /// and `target.spm`.
    pub fn new<T: AsRef<Path>>(path: T) -> Result<Self> {
        Tokenizer::from_file(
            path.as_ref().join("source.spm"),
            path.as_ref().join("target.spm"),
        )
    }

    /// Create a tokenizer instance by specifying the path to `source.spm` and `target.spm`.
    pub fn from_file<T: AsRef<Path>, U: AsRef<Path>>(src: T, target: U) -> Result<Self> {
        Ok(Self {
            enc: SentencePieceProcessor::open(src)?,
            dec: SentencePieceProcessor::open(target)?,
        })
    }
}

impl crate::Tokenizer for Tokenizer {
    fn encode(&self, input: &str) -> Result<Vec<String>> {
        let source: Vec<String> = self
            .enc
            .encode(input)?
            .iter()
            .map(|v| v.piece.to_string())
            .collect();
        Ok(source)
    }

    fn decode(&self, tokens: Vec<String>) -> Result<String> {
        self.dec.decode_pieces(&tokens).map_err(Error::new)
    }
}
