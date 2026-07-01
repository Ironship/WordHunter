#[cfg(feature = "tokenizers")]
pub mod bpe;
#[cfg(feature = "tokenizers")]
pub mod hf;
#[cfg(feature = "rust_tokenizers")]
pub mod rust_tokenizers;
#[cfg(feature = "sentencepiece")]
pub mod sentencepiece;

pub trait Tokenizer {
    /// Encodes a given string into a sequence of tokens
    fn encode(&self, input: &str) -> anyhow::Result<Vec<String>>;

    /// Decodes a given sequence of tokens back into a single string
    fn decode(&self, tokens: Vec<String>) -> anyhow::Result<String>;
}
