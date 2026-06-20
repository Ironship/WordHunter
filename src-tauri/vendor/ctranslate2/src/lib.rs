//! # Basic Usage
//! ```
//!  let sources = vec![
//!     "Hallo World!",
//!     "This crate provides Rust bindings for CTranslate2."
//! ];
//! let translator = Translator2::new("/path/to/model", &Default::default(), tokenizer::rust_tokenizers::SentenceTokenizer::new("/path/to/tokenizer"))?;
//! let results = translator.translate_batch(&sources, &Default::default())?;
//! for (r, _) in results{
//!     println!("{}", r);
//! }
//! ```

//!
pub mod compute_type;
pub mod device;
pub mod tokenizer;
pub mod translator;
pub mod translator2;
pub use compute_type::ComputeType;
pub use device::Device;
pub use tokenizer::Tokenizer;
pub use translator::TranslationOptions;
pub use translator::Translator;
pub use translator::TranslatorConfig;
pub use translator2::Translator2;
