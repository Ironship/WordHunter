// Review & reader-algorithm settings section (former monolithic
// events/settings.ts): words-per-page pagination, word-detection algorithm
// remapping and SRS/review-graph preferences.
import { state, saveState } from "../../state.js";
import { els } from "../../dom.js";
import { render } from "../../render.js";
import { applyPreferences, updatePreferenceValue } from "../../preferences.js";
import { renderReader } from "../../reader/renderer.js";
import { renderReview } from "../../views/vocabulary.js";
import { remapReaderBookmarksForAlgorithm } from "../../reader/bookmarks.js";
import { byId, beginWordAlgorithmChange, currentWordAlgorithmChangeGeneration } from "./shared.js";

function resetReaderScrollForCurrentText() {
  if (!state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};
  state.readerScrolls[state.currentTextId] = { wordIndex: null, scrollTop: 0, readerPage: 1 };
}

export function bindReviewSettings() {
  if (els.prefWordsPerPage) els.prefWordsPerPage.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.readerPage = 1; // reset page when changing words per page
    resetReaderScrollForCurrentText();
    updatePreferenceValue("wordsPerPage", target.value);
    renderReader();
  });
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.addEventListener("change", async (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const algorithm = target.value === "classic" ? "classic" : "modern";
    const generation = beginWordAlgorithmChange();
    await remapReaderBookmarksForAlgorithm(algorithm);
    const selectedAlgorithm = target.value === "classic" ? "classic" : "modern";
    if (generation !== currentWordAlgorithmChangeGeneration() || selectedAlgorithm !== algorithm) return;
    state.preferences.wordDetectionAlgorithm = algorithm;
    for (const position of Object.values(state.readerScrolls || {})) {
      if (position && typeof position === "object") position.wordIndex = null;
    }
    state.readerPage = 1;
    resetReaderScrollForCurrentText();
    saveState();
    applyPreferences();
    render();
  });
  if (byId<HTMLSelectElement>("pref-srs-algorithm")) byId<HTMLSelectElement>("pref-srs-algorithm").addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.preferences.srsAlgorithm = target.value === "sm2" ? "sm2" : "fsrs";
    saveState();
    applyPreferences();
    renderReview();
  });
  if (byId<HTMLInputElement>("pref-in-text-review")) byId<HTMLInputElement>("pref-in-text-review").addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    updatePreferenceValue("inTextReview", target.checked);
    renderReader();
  });
  if (byId<HTMLSelectElement>("pref-review-graph-type")) byId<HTMLSelectElement>("pref-review-graph-type").addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    updatePreferenceValue("reviewGraphType", target.value);
    import("../../views/vocabulary.js").then(m => m.renderReview());
  });
}
