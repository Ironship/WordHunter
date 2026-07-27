import { registerFrontendStateFlusher, state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { renderVocabulary } from "../views/vocabulary.js";
import { VOCAB_STATUS_FILTERS } from "./vocab-status.js";

function isVocabStatus(status: string): status is WhVocabStatus {
  return VOCAB_STATUS_FILTERS.includes(status);
}

export function bindVocabularyFilterEvents() {
  let vocabSearchDebounceTimer: number | null = null;
  const flushVocabSearch = () => {
    if (vocabSearchDebounceTimer !== null) clearTimeout(vocabSearchDebounceTimer);
    vocabSearchDebounceTimer = null;
    if (els.vocabSearch && state.filters.vocabQuery !== els.vocabSearch.value) {
      state.filters.vocabQuery = els.vocabSearch.value;
      void saveUiState();
      renderVocabulary();
    }
  };
  registerFrontendStateFlusher(flushVocabSearch);
  els.vocabSearch.addEventListener("input", () => {
    if (vocabSearchDebounceTimer !== null) clearTimeout(vocabSearchDebounceTimer);
    vocabSearchDebounceTimer = setTimeout(flushVocabSearch, 200);
  });

  if (els.vocabStatusFilters?.length) {
    els.vocabStatusFilters.forEach((input) => input.addEventListener("change", () => {
      const selected = els.vocabStatusFilters
        .filter((cb) => cb.checked)
        .map((cb) => cb.value)
        .filter(isVocabStatus);
      state.filters.vocabStatuses = selected;
      void saveUiState();
      renderVocabulary();
    }));
  } else if (els.vocabStatusFilter instanceof HTMLSelectElement) {
    const legacyFilter = els.vocabStatusFilter;
    legacyFilter.addEventListener("change", () => {
      state.filters.vocabStatuses = legacyFilter.value === "all"
        ? [...VOCAB_STATUS_FILTERS]
        : legacyFilter.value === "not_ignored"
          ? ["new", "learning", "known"]
          : [legacyFilter.value].filter(isVocabStatus);
      void saveUiState();
      renderVocabulary();
    });
  }

  if (els.vocabTextFilter) {
    els.vocabTextFilter.addEventListener("change", () => {
      state.filters.vocabTextId = els.vocabTextFilter.value || "all";
      void saveUiState();
      renderVocabulary();
    });
  }
}
