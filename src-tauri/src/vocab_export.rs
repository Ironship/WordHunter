mod filter;
mod handle;
mod tsv;

pub use handle::handle;

#[cfg(test)]
#[path = "tests/vocab_export/tests.rs"]
mod tests;
