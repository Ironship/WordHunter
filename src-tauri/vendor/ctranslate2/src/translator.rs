use std::{
    ffi::{CStr, CString, NulError, c_char, c_int, c_long, c_void},
    fmt,
    path::Path,
    ptr::{self, NonNull},
};

use ctranslate2_sys::{
    CTranslationOptions, CTranslationResult, CTranslator, translation_result_free,
    translation_result_has_attention, translation_result_has_scores,
    translation_result_num_hypotheses, translation_result_output_at,
    translation_result_output_size, translation_result_score, translator_create,
};

use crate::{compute_type::ComputeType, device::Device};

pub struct Translator {
    inner: NonNull<CTranslator>,
}

pub struct TranslationResult {
    inner: *mut CTranslationResult,
}

unsafe impl Send for TranslationResult {}
unsafe impl Sync for TranslationResult {}
unsafe impl Send for Translator {}
unsafe impl Sync for Translator {}

impl TranslationResult {
    pub fn score(&self) -> f32 {
        unsafe { translation_result_score(self.inner) }
    }

    pub fn has_attention(&self) -> bool {
        unsafe { translation_result_has_attention(self.inner) }
    }

    pub fn has_scores(&self) -> bool {
        unsafe { translation_result_has_scores(self.inner) }
    }

    pub fn num_hypotheses(&self) -> usize {
        unsafe { translation_result_num_hypotheses(self.inner) }
    }

    pub fn output(&self) -> Vec<String> {
        unsafe {
            let len = translation_result_output_size(self.inner);
            let mut out = Vec::with_capacity(len);
            for idx in 0..len {
                let ptr = translation_result_output_at(self.inner, idx);
                out.push(CStr::from_ptr(ptr).to_string_lossy().to_string());
            }
            out
        }
    }
}

impl Drop for TranslationResult {
    fn drop(&mut self) {
        unsafe {
            translation_result_free(self.inner);
        }
    }
}

impl Drop for Translator {
    fn drop(&mut self) {
        // Word Hunter runs CTranslate2 in a short-lived worker process. On
        // Windows the upstream C++ destructor can block indefinitely after a
        // translation, so the worker lets the OS reclaim this allocation when
        // the process exits.
        let _ = self.inner;
    }
}

#[derive(Debug)]
pub enum TranslatorError {
    NulInPath(NulError),
    CreationFailed,
}

impl fmt::Display for TranslatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TranslatorError::NulInPath(err) => {
                write!(f, "Invalid path (contains null byte): {}", err)
            }
            TranslatorError::CreationFailed => write!(f, "Failed to create the translator"),
        }
    }
}

// Implement std::error::Error for compatibility with `?` and other error handling
impl std::error::Error for TranslatorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TranslatorError::NulInPath(err) => Some(err),
            TranslatorError::CreationFailed => None,
        }
    }
}

pub struct TranslatorConfig {
    pub device: Device,
    pub compute_type: ComputeType,
    pub device_indices: Vec<i32>,
    pub tensor_parallel: bool,
    pub num_threads_per_replica: usize,
    pub max_queued_batches: i64,
    pub cpu_core_offset: i32,
}

impl Default for TranslatorConfig {
    fn default() -> Self {
        Self {
            device: Device::Cpu,
            compute_type: ComputeType::Default,
            device_indices: vec![0],
            tensor_parallel: false,
            num_threads_per_replica: 0,
            max_queued_batches: 0,
            cpu_core_offset: -1,
        }
    }
}

#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BatchType {
    Examples,
    Tokens,
}

#[derive(Clone)]
pub struct TranslationOptions {
    pub beam_size: usize,
    pub patience: f32,
    pub length_penalty: f32,
    pub coverage_penalty: f32,
    pub repetition_penalty: f32,
    pub no_repeat_ngram_size: usize,
    pub disable_unk: bool,
    pub suppress_sequences: Vec<Vec<String>>,
    pub prefix_bias_beta: f32,
    pub return_end_token: bool,
    pub max_input_length: usize,
    pub max_decoding_length: usize,
    pub min_decoding_length: usize,
    pub sampling_topk: usize,
    pub sampling_topp: f32,
    pub sampling_temperature: f32,
    pub use_vmap: bool,
    pub num_hypotheses: usize,
    pub return_scores: bool,
    pub return_attention: bool,
    pub return_logits_vocab: bool,
    pub return_alternatives: bool,
    pub min_alternative_expansion_prob: f32,
    pub replace_unknowns: bool,

    pub max_batch_size: usize,
    pub batch_type: BatchType,
}

impl Default for TranslationOptions {
    fn default() -> Self {
        Self {
            // TODO:
            // std::vector< std::vector< std::string > > 	suppress_sequences
            // std::variant< std::string, std::vector< std::string >, std::vector< size_t > > 	end_token
            // std::function< bool(GenerationStepResult)> 	callback = nullptr
            beam_size: 2,
            patience: 1.0,
            length_penalty: 1.0,
            coverage_penalty: 0.0,
            repetition_penalty: 1.0,
            no_repeat_ngram_size: 0,
            disable_unk: false,
            suppress_sequences: Default::default(),
            prefix_bias_beta: 0.0,
            return_end_token: false,
            max_input_length: 1024,
            max_decoding_length: 256,
            min_decoding_length: 1,
            sampling_topk: 1,
            sampling_topp: 1.0,
            sampling_temperature: 1.0,
            use_vmap: false,
            num_hypotheses: 1,
            return_scores: false,
            return_attention: false,
            return_logits_vocab: false,
            return_alternatives: false,
            min_alternative_expansion_prob: 0.0,
            replace_unknowns: false,
            max_batch_size: 0,
            batch_type: BatchType::Examples,
        }
    }
}

fn to_c_translation_options(options: &TranslationOptions) -> CTranslationOptions {
    CTranslationOptions {
        prefix_bias_beta: options.prefix_bias_beta,
        return_end_token: options.return_end_token,
        beam_size: options.beam_size,
        patience: options.patience,
        length_penalty: options.length_penalty,
        coverage_penalty: options.coverage_penalty,
        repetition_penalty: options.repetition_penalty,
        no_repeat_ngram_size: options.no_repeat_ngram_size,
        disable_unk: if options.disable_unk { 1 } else { 0 },
        max_input_length: options.max_input_length,
        max_decoding_length: options.max_decoding_length,
        min_decoding_length: options.min_decoding_length,
        sampling_topk: options.sampling_topk,
        sampling_topp: options.sampling_topp,
        sampling_temperature: options.sampling_temperature,
        use_vmap: if options.use_vmap { 1 } else { 0 },
        num_hypotheses: options.num_hypotheses,
        return_scores: if options.return_scores { 1 } else { 0 },
        return_attention: if options.return_attention { 1 } else { 0 },
        return_logits_vocab: if options.return_logits_vocab { 1 } else { 0 },
        return_alternatives: if options.return_alternatives { 1 } else { 0 },
        min_alternative_expansion_prob: options.min_alternative_expansion_prob,
        replace_unknowns: if options.replace_unknowns { 1 } else { 0 },
    }
}

fn prepare_string(tokens: &[Vec<String>]) -> Result<Vec<Vec<CString>>, TranslatorError> {
    tokens
        .iter()
        .map(|sentence| {
            sentence
                .iter()
                .map(|s| CString::new(s.as_str()).map_err(|e| TranslatorError::NulInPath(e)))
                .collect()
        })
        .collect()
}

fn prepare_string_pts(
    c_sentences: &[Vec<CString>],
) -> (Vec<Vec<*const c_char>>, Vec<*const *const c_char>) {
    let c_ptrs: Vec<Vec<*const c_char>> = c_sentences
        .iter()
        .map(|sentence| {
            let mut s: Vec<*const c_char> = sentence.iter().map(|s| s.as_ptr()).collect();
            s.push(ptr::null());
            s
        })
        .collect();
    let c_sentences_ptrs: Vec<*const *const c_char> = c_ptrs.iter().map(|s| s.as_ptr()).collect();
    (c_ptrs, c_sentences_ptrs)
}

impl Translator {
    pub fn new<P: AsRef<Path>>(
        model_path: P,
        config: &TranslatorConfig,
    ) -> Result<Self, TranslatorError> {
        let c_model = CString::new(model_path.as_ref().to_string_lossy().into_owned())
            .map_err(TranslatorError::NulInPath)?;

        let (device_indices_ptr, num_device_indices) = (
            config.device_indices.as_ptr() as *const c_int,
            config.device_indices.len(),
        );

        let raw = unsafe {
            translator_create(
                c_model.as_ptr(),
                config.device as c_int,
                config.compute_type as c_int,
                device_indices_ptr,
                num_device_indices,
                config.tensor_parallel as c_int,
                config.num_threads_per_replica,
                config.max_queued_batches as c_long,
                config.cpu_core_offset as c_int,
            )
        };

        let non_null = NonNull::new(raw).ok_or(TranslatorError::CreationFailed)?;
        Ok(Translator { inner: non_null })
    }
    pub fn translate_batch2(
        &self,
        tokens: &[Vec<String>],
        prefixes: &[Vec<String>],
        options: TranslationOptions,
    ) -> Result<Vec<TranslationResult>, TranslatorError> {
        let opt = to_c_translation_options(&options);
        unsafe {
            let c_sentences = prepare_string(tokens)?;
            let (_c_ptrs, c_sentences_ptrs) = prepare_string_pts(&c_sentences);

            let c_prefixes = prepare_string(prefixes)?;
            let (_prefix_ptrs, c_prefixes_ptrs) = prepare_string_pts(&c_prefixes);

            let num_sentences = c_sentences_ptrs.len();

            let mut out_num_translations: usize = 0;

            let results_ptr = ctranslate2_sys::translator_translate_batch_with_target_prefix(
                self.inner.as_ptr(),
                c_sentences_ptrs.as_ptr() as *mut *mut *const c_char,
                c_prefixes_ptrs.as_ptr() as *mut *mut *const c_char,
                num_sentences,
                &opt,
                options.max_batch_size,
                options.batch_type as i32,
                &mut out_num_translations,
            );
            let results = take_c_results(results_ptr, out_num_translations)
                .into_iter()
                .map(|v| TranslationResult { inner: v })
                .collect::<Vec<_>>();

            Ok(results)
        }
    }

    pub fn translate_batch(
        &self,
        tokens: &[Vec<String>],
        options: TranslationOptions,
    ) -> Result<Vec<TranslationResult>, TranslatorError> {
        let opt = to_c_translation_options(&options);
        unsafe {
            let c_sentences = prepare_string(tokens)?;
            let (_c_ptrs, c_sentences_ptrs) = prepare_string_pts(&c_sentences);

            let num_sentences = c_sentences_ptrs.len();

            let mut out_num_translations: usize = 0;

            let results_ptr = ctranslate2_sys::translator_translate_batch(
                self.inner.as_ptr(),
                c_sentences_ptrs.as_ptr() as *mut *mut *const c_char,
                num_sentences,
                &opt,
                options.max_batch_size,
                options.batch_type as i32,
                &mut out_num_translations,
            );
            let results = take_c_results(results_ptr, out_num_translations)
                .into_iter()
                .map(|v| TranslationResult { inner: v })
                .collect::<Vec<_>>();

            Ok(results)
        }
    }
}

fn take_c_results<T>(c_results: *mut *mut T, n: usize) -> Vec<*mut T> {
    unsafe {
        let owned = std::slice::from_raw_parts(c_results.clone(), n).to_vec();
        ctranslate2_sys::free_pointer_array(c_results as *mut *mut c_void);
        owned
    }
}
