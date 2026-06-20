#include "translator_wrapper.h"
#include "ctranslate2/replica_pool.h"
#include "ctranslate2/translator.h"
#include <cstdio>
#include <cstdlib>
#include <vector>

struct CTranslator {
  ctranslate2::Translator *translator;
};

static void ct2_debug(const char *message) {
  if (std::getenv("WH_CT2_DEBUG")) {
    std::fprintf(stderr, "[ct2] %s\n", message);
    std::fflush(stderr);
  }
}

static std::vector<std::vector<std::string>>
c_strings_to_cpp(const char ***strings, const size_t *lengths,
                 size_t num_sentences) {
  std::vector<std::vector<std::string>> result(num_sentences);
  for (size_t i = 0; i < num_sentences; ++i) {
    result[i].resize(lengths[i]);
    for (size_t j = 0; j < lengths[i]; ++j) {
      result[i][j] = std::string(strings[i][j]);
    }
  }
  return result;
}

CTranslator *translator_create(const char *model_path, int device,
                               int compute_type, const int *device_indices,
                               size_t num_device_indices, int tensor_parallel,
                               size_t num_threads_per_replica,
                               long max_queued_batches, int cpu_core_offset) {
  if (!model_path)
    return nullptr;

  ctranslate2::Device cpp_device =
      (device == 1) ? ctranslate2::Device::CUDA : ctranslate2::Device::CPU;

  ctranslate2::ComputeType cpp_compute_type =
      static_cast<ctranslate2::ComputeType>(compute_type);

  std::vector<int> indices;
  if (device_indices && num_device_indices > 0) {
    indices.assign(device_indices, device_indices + num_device_indices);
  } else {
    indices.push_back(0);
  }

  ctranslate2::ReplicaPoolConfig config;
  config.num_threads_per_replica = num_threads_per_replica;
  config.max_queued_batches = max_queued_batches;
  config.cpu_core_offset = cpu_core_offset;

  CTranslator *wrapper = new CTranslator;
  try {
    ct2_debug("translator_create: before new Translator");
    wrapper->translator = new ctranslate2::Translator(
        std::string(model_path), cpp_device, cpp_compute_type, indices,
        tensor_parallel != 0, config);
    ct2_debug("translator_create: after new Translator");
  } catch (...) {
    delete wrapper;
    return nullptr;
  }

  return wrapper;
}

void translator_destroy(CTranslator *tanslator) {
  if (!tanslator)
    return;
  delete tanslator->translator;
  delete tanslator;
}

struct CTranslationResult {
  ctranslate2::TranslationResult *tr;
};

void translation_result_free(CTranslationResult *result) {
  delete result->tr;
  delete result;
}

void free_pointer_array(void **array) { delete[] array; }

size_t translation_result_num_hypotheses(const CTranslationResult *result) {
  return result->tr->num_hypotheses();
}

bool translation_result_has_scores(const CTranslationResult *result) {
  return result->tr->has_scores();
}

bool translation_result_has_attention(const CTranslationResult *result) {
  return result->tr->has_attention();
}

const char *translation_result_output_at(const CTranslationResult *result,
                                         size_t idx) {
  const auto &vec = result->tr->output();
  return vec[idx].c_str();
}
size_t translation_result_output_size(const CTranslationResult *result) {
  return result->tr->output().size();
}

float translation_result_score(const CTranslationResult *result) {
  return result->tr->score();
}

inline std::vector<std::vector<std::string>>
to_string_vector(const char ***source, size_t num_sentences) {
  std::vector<std::vector<std::string>> result;
  result.reserve(num_sentences);

  for (size_t i = 0; i < num_sentences; ++i) {
    std::vector<std::string> sentence;
    for (size_t j = 0; source[i][j] != nullptr; ++j)
      sentence.emplace_back(source[i][j]);
    result.emplace_back(std::move(sentence));
  }

  return result;
}

inline ctranslate2::TranslationOptions
to_cpp_translation_options(const CTranslationOptions *options) {
  ctranslate2::TranslationOptions cpp_options;

  if (!options)
    return cpp_options;

  cpp_options.beam_size = options->beam_size;
  cpp_options.patience = options->patience;
  cpp_options.length_penalty = options->length_penalty;
  cpp_options.coverage_penalty = options->coverage_penalty;
  cpp_options.repetition_penalty = options->repetition_penalty;
  cpp_options.no_repeat_ngram_size = options->no_repeat_ngram_size;
  cpp_options.disable_unk = options->disable_unk != 0;
  cpp_options.max_input_length = options->max_input_length;
  cpp_options.max_decoding_length = options->max_decoding_length;
  cpp_options.min_decoding_length = options->min_decoding_length;
  cpp_options.sampling_topk = options->sampling_topk;
  cpp_options.sampling_topp = options->sampling_topp;
  cpp_options.sampling_temperature = options->sampling_temperature;
  cpp_options.use_vmap = options->use_vmap != 0;
  cpp_options.num_hypotheses = options->num_hypotheses;
  cpp_options.return_scores = options->return_scores != 0;
  cpp_options.return_attention = options->return_attention != 0;
  cpp_options.return_logits_vocab = options->return_logits_vocab != 0;
  cpp_options.return_alternatives = options->return_alternatives != 0;
  cpp_options.min_alternative_expansion_prob =
      options->min_alternative_expansion_prob;
  cpp_options.replace_unknowns = options->replace_unknowns != 0;

  return cpp_options;
}

CTranslationResult **translator_translate_batch(
    CTranslator *translator, const char ***source, size_t num_sentences,
    const CTranslationOptions *options, size_t max_batch_size, int batch_type,
    size_t *out_num_translations) {
  if (!translator || !source || !max_batch_size || !out_num_translations ||
      !num_sentences)
    return nullptr;

  std::vector<std::vector<std::string>> cpp_source =
      to_string_vector(source, num_sentences);
  ct2_debug("translator_translate_batch: source converted");

  ctranslate2::TranslationOptions cpp_options =
      to_cpp_translation_options(options);

  ctranslate2::BatchType cpp_batch_type =
      (batch_type == 1) ? ctranslate2::BatchType::Tokens
                        : ctranslate2::BatchType::Examples;

  ct2_debug("translator_translate_batch: before translate_batch");
  std::vector<ctranslate2::TranslationResult> results =
      translator->translator->translate_batch(cpp_source, cpp_options,
                                              max_batch_size, cpp_batch_type);
  ct2_debug("translator_translate_batch: after translate_batch");

  CTranslationResult **c_results = new CTranslationResult *[results.size()];
  for (size_t i = 0; i < results.size(); ++i) {
    c_results[i] = new CTranslationResult;
    c_results[i]->tr =
        new ctranslate2::TranslationResult(std::move(results[i]));
  }

  *out_num_translations = results.size();
  return c_results;
}

CTranslationResult **translator_translate_batch_with_target_prefix(
    CTranslator *translator, const char ***source,
    const char ***target_prefixes, size_t num_sentences,
    const CTranslationOptions *options, size_t max_batch_size,

    int batch_type, size_t *out_num_translations) {
  if (!translator || !source || !max_batch_size || !out_num_translations ||
      !num_sentences || !target_prefixes)
    return nullptr;

  std::vector<std::vector<std::string>> cpp_source =
      to_string_vector(source, num_sentences);

  std::vector<std::vector<std::string>> cpp_tprefixes =
      to_string_vector(target_prefixes, num_sentences);

  ctranslate2::TranslationOptions cpp_options =
      to_cpp_translation_options(options);

  ctranslate2::BatchType cpp_batch_type =
      (batch_type == 1) ? ctranslate2::BatchType::Tokens
                        : ctranslate2::BatchType::Examples;

  std::vector<ctranslate2::TranslationResult> results =
      translator->translator->translate_batch(cpp_source, cpp_tprefixes,
                                              cpp_options, max_batch_size,
                                              cpp_batch_type);

  CTranslationResult **c_results = new CTranslationResult *[results.size()];
  for (size_t i = 0; i < results.size(); ++i) {
    c_results[i] = new CTranslationResult;
    c_results[i]->tr =
        new ctranslate2::TranslationResult(std::move(results[i]));
  }

  *out_num_translations = results.size();
  return c_results;
}
