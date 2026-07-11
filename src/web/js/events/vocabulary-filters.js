import { registerFrontendStateFlusher, state, saveState } from "../state.js";
import { els } from "../dom.js";
import { renderVocabulary } from "../views/vocabulary.js";
import { VOCAB_STATUS_FILTERS } from "./vocab-status.js";

export function bindVocabularyFilterEvents() {
  let vocabSearchDebounceTimer = null;
  const flushVocabSearch = () => {
    clearTimeout(vocabSearchDebounceTimer);
    vocabSearchDebounceTimer = null;
    if (els.vocabSearch && state.filters.vocabQuery !== els.vocabSearch.value) {
      state.filters.vocabQuery = els.vocabSearch.value;
      saveState();
      renderVocabulary();
    }
  };
  registerFrontendStateFlusher(flushVocabSearch);
  els.vocabSearch.addEventListener("input", () => {
    clearTimeout(vocabSearchDebounceTimer);
    vocabSearchDebounceTimer = setTimeout(flushVocabSearch, 200);
  });

  if (els.vocabStatusFilters?.length) {
    els.vocabStatusFilters.forEach((input) => input.addEventListener("change", () => {
      const selected = els.vocabStatusFilters
        .filter((cb) => cb.checked)
        .map((cb) => cb.value)
        .filter((status) => VOCAB_STATUS_FILTERS.includes(status));
      state.filters.vocabStatuses = selected;
      saveState();
      renderVocabulary();
    }));
  } else if (els.vocabStatusFilter) {
    els.vocabStatusFilter.addEventListener("change", () => {
      state.filters.vocabStatuses = els.vocabStatusFilter.value === "all"
        ? [...VOCAB_STATUS_FILTERS]
        : els.vocabStatusFilter.value === "not_ignored"
          ? ["new", "learning", "known"]
          : [els.vocabStatusFilter.value].filter((status) => VOCAB_STATUS_FILTERS.includes(status));
      saveState();
      renderVocabulary();
    });
  }

  if (els.vocabTextFilter) {
    els.vocabTextFilter.addEventListener("change", () => {
      state.filters.vocabTextId = els.vocabTextFilter.value || "all";
      saveState();
      renderVocabulary();
    });
  }
}
