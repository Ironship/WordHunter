mod cache_key;
mod handle;
mod hash;
mod index;
mod stats;

pub use handle::handle;

#[cfg(test)]
#[path = "tests/vocab_index/tests.rs"]
mod tests;
