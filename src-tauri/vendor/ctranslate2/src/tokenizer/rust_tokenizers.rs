use std::path::Path;

use rust_tokenizers::tokenizer::{SentencePieceTokenizer, Tokenizer as _};

pub struct SentenceTokenizer {
    spp: SentencePieceTokenizer,
}

impl SentenceTokenizer {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        let spp = SentencePieceTokenizer::from_file(path, false).unwrap();
        Self { spp }
    }
}

impl crate::Tokenizer for SentenceTokenizer {
    fn encode(&self, input: &str) -> anyhow::Result<Vec<String>> {
        let mut tokens = self.spp.tokenize(input);
        tokens.push("</s>".to_owned());
        Ok(tokens)
    }

    fn decode(&self, tokens: Vec<String>) -> anyhow::Result<String> {
        Ok(self.spp.convert_tokens_to_string(tokens).trim().to_owned())
    }
}
