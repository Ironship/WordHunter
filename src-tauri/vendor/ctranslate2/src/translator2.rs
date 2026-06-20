use std::path::Path;

use crate::{
    Tokenizer, TranslationOptions, Translator, TranslatorConfig, translator::TranslatorError,
};

pub struct Translator2<T: Tokenizer> {
    t: Translator,
    tokenizer: T,
}

#[inline]
pub(crate) fn encode_all<T: Tokenizer, U: AsRef<str>>(
    tokenizer: &T,
    sources: &[U],
) -> anyhow::Result<Vec<Vec<String>>> {
    sources
        .iter()
        .map(|s| tokenizer.encode(s.as_ref()))
        .collect()
}

impl<T: Tokenizer> Translator2<T> {
    pub fn new<P: AsRef<Path>>(
        model_path: P,
        config: &TranslatorConfig,
        tokenizer: T,
    ) -> Result<Self, TranslatorError> {
        Ok(Translator2 {
            t: Translator::new(model_path, config)?,
            tokenizer,
        })
    }

    pub fn translate_batch(
        &self,
        sources: &[String],
        options: TranslationOptions,
    ) -> anyhow::Result<Vec<(String, f32)>> {
        let out = self
            .t
            .translate_batch(&encode_all(&self.tokenizer, sources)?, options)?;
        ct2_debug("translator2: after t.translate_batch");
        let mut res = Vec::new();
        for r in out.into_iter() {
            ct2_debug("translator2: before has_scores");
            let score = if r.has_scores() { r.score() } else { 0.0 };
            ct2_debug("translator2: before output");
            let output = r.output();
            ct2_debug("translator2: before decode");
            let decoded = self
                .tokenizer
                .decode(output)
                .map_err(|err| anyhow::anyhow!("failed to decode: {err}"))?;
            std::mem::forget(r);
            res.push((decoded, score));
            ct2_debug("translator2: after decode");
        }
        Ok(res)
    }

    pub fn translate_batch_with_prefixes<U, V>(
        &self,
        sources: &[U],
        target_prefixes: &Vec<Vec<V>>,
        options: TranslationOptions,
    ) -> anyhow::Result<Vec<(String, f32)>>
    where
        U: AsRef<str>,
        V: AsRef<str>,
    {
        let out = self
            .t
            .translate_batch(&encode_all(&self.tokenizer, sources)?, options)?;
        let mut res = Vec::new();
        for (r, prefix) in out.into_iter().zip(target_prefixes) {
            let score = if r.has_scores() { r.score() } else { 0.0 };
            let mut hypotheses = r.output();
            hypotheses.drain(0..prefix.len());

            let decoded = self
                .tokenizer
                .decode(hypotheses)
                .map_err(|err| anyhow::anyhow!("failed to decode: {err}"))?;
            std::mem::forget(r);
            res.push((
                decoded,
                score,
            ));
        }
        Ok(res)
    }
}

fn ct2_debug(message: &str) {
    if std::env::var_os("WH_CT2_DEBUG").is_some() {
        eprintln!("[ct2-rs] {message}");
    }
}
