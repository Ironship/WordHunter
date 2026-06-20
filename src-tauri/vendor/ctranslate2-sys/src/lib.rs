use std::os::raw::{c_char, c_int, c_long, c_void};

#[repr(C)]
pub struct CTranslator {
    _private: [u8; 0],
}

#[repr(C)]
pub struct CTranslationResult {
    _private: [u8; 0],
}

#[repr(C)]
pub struct CTranslationOptions {
    pub beam_size: usize,
    pub patience: f32,
    pub length_penalty: f32,
    pub coverage_penalty: f32,
    pub repetition_penalty: f32,
    pub no_repeat_ngram_size: usize,
    pub disable_unk: c_int,
    pub max_input_length: usize,
    pub max_decoding_length: usize,
    pub min_decoding_length: usize,
    pub sampling_topk: usize,
    pub return_end_token: bool,
    pub prefix_bias_beta: f32,
    pub sampling_topp: f32,
    pub sampling_temperature: f32,
    pub use_vmap: c_int,
    pub num_hypotheses: usize,
    pub return_scores: c_int,
    pub return_attention: c_int,
    pub return_logits_vocab: c_int,
    pub return_alternatives: c_int,
    pub min_alternative_expansion_prob: f32,
    pub replace_unknowns: c_int,
}

unsafe extern "C" {
    pub fn free_pointer_array(array: *mut *mut c_void);

    pub fn translator_create(
        model_path: *const c_char,
        device: c_int,
        compute_type: c_int,
        device_indices: *const c_int,
        num_device_indices: usize,
        tensor_parallel: c_int,
        num_threads_per_replica: usize,
        max_queued_batches: c_long,
        cpu_core_offset: c_int,
    ) -> *mut CTranslator;

    pub fn translator_destroy(pool: *mut CTranslator);

    pub fn translator_translate_batch(
        translator: *mut CTranslator,
        source: *mut *mut *const c_char,
        num_sentences: usize,
        options: *const CTranslationOptions,
        max_batch_size: usize,
        batch_type: c_int,
        out_num_translations: *mut usize,
    ) -> *mut *mut CTranslationResult;

    pub fn translator_translate_batch_with_target_prefix(
        translator: *mut CTranslator,
        source: *mut *mut *const c_char,
        target_prefixes: *mut *mut *const c_char,
        num_sentences: usize,
        options: *const CTranslationOptions,
        max_batch_size: usize,
        batch_type: c_int,
        out_num_translations: *mut usize,
    ) -> *mut *mut CTranslationResult;

    pub fn translation_result_free(result: *mut CTranslationResult);
    pub fn translation_result_num_hypotheses(result: *const CTranslationResult) -> usize;
    pub fn translation_result_has_scores(result: *const CTranslationResult) -> bool;
    pub fn translation_result_has_attention(result: *const CTranslationResult) -> bool;
    pub fn translation_result_output_at(
        result: *const CTranslationResult,
        idx: usize,
    ) -> *const c_char;
    pub fn translation_result_output_size(result: *const CTranslationResult) -> usize;
    pub fn translation_result_score(result: *const CTranslationResult) -> f32;
}
