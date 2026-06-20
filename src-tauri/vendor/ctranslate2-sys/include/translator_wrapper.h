// c_translator_wrapper.h
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

typedef struct CTranslator CTranslator;

typedef struct CTranslationOptions {
  size_t beam_size;
  float patience;
  float length_penalty;
  float coverage_penalty;
  float repetition_penalty;
  size_t no_repeat_ngram_size;
  int disable_unk;
  size_t max_input_length;
  size_t max_decoding_length;
  size_t min_decoding_length;
  size_t sampling_topk;
  bool return_end_token;
  float prefix_bias_beta = 0;
  float sampling_topp;
  float sampling_temperature;
  int use_vmap;
  size_t num_hypotheses;
  int return_scores;
  int return_attention;
  int return_logits_vocab;
  int return_alternatives;
  float min_alternative_expansion_prob;
  int replace_unknowns;
} CTranslationOptions;

void free_pointer_array(void **array);

CTranslator *translator_create(const char *model_path, int device,
                               int compute_type, const int *device_indices,
                               size_t num_device_indices, int tensor_parallel,
                               size_t num_threads_per_replica,
                               long max_queued_batches, int cpu_core_offset);

void translator_destroy(CTranslator *pool);
typedef struct CTranslationResult CTranslationResult;

CTranslationResult **translator_translate_batch(
    CTranslator *translator, const char ***source, size_t num_sentences,
    const CTranslationOptions *options, size_t max_batch_size, int batch_type,
    size_t *out_num_translations);

CTranslationResult **translator_translate_batch_with_target_prefix(
    CTranslator *translator, const char ***source,
    const char ***target_prefixes, size_t num_sentences,
    const CTranslationOptions *options, size_t max_batch_size, int batch_type,
    size_t *out_num_translations);

void translation_result_free(CTranslationResult *result);

// Getters
size_t translation_result_num_hypotheses(const CTranslationResult *result);
bool translation_result_has_scores(const CTranslationResult *result);
bool translation_result_has_attention(const CTranslationResult *result);

const char *translation_result_output_at(const CTranslationResult *result,
                                         size_t idx);
size_t translation_result_output_size(const CTranslationResult *result);
float translation_result_score(const CTranslationResult *result);

#ifdef __cplusplus
}
#endif
