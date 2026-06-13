// Render orchestrator.
import { state, saveState, getLastReadTextId } from "./state.js";
import { renderShell } from "./views/shell.js";
import { renderLibrary } from "./views/library.js";
import { renderReader, updateReaderSelection, rememberReaderScrollPosition } from "./views/reader.js";
import { renderVocabulary, renderReview } from "./views/vocabulary.js";
import { renderDiscover, cancelAllStatsFetches } from "./views/discover.js";
import { renderGraphs } from "./views/graphs.js";
import { renderTranslator } from "./views/translator.js";
import { syncSettingsControls } from "./preferences.js";
import { getTextById } from "./views/reader.js";

export function render() {
  renderShell();
  const viewName = state.currentView || "library";
  if (viewName === "library") renderLibrary();
  if (viewName === "reader") renderReader();
  if (viewName === "vocabulary") { renderVocabulary(); renderReview(); }
  if (viewName === "flashcards") renderReview();
  if (viewName === "graphs") renderGraphs();
  if (viewName === "discover") renderDiscover();
  if (viewName === "translator") renderTranslator();
  if (viewName === "settings") syncSettingsControls();
}

export function setView(viewName) {
  if (state.currentView === "reader" && viewName !== "reader") {
    rememberReaderScrollPosition();
    if (state.currentTextId) {
      if (!state.readerPages) state.readerPages = {};
      state.readerPages[state.currentTextId] = state.readerPage;
    }
  }
  if (state.currentView === "discover" && viewName !== "discover") {
    cancelAllStatsFetches();
  }
  state.currentView = viewName;
  saveState();
  renderShell();
  if (viewName === "library") renderLibrary();
  if (viewName === "reader") renderReader();
  if (viewName === "vocabulary") { renderVocabulary(); renderReview(); }
  if (viewName === "flashcards") { renderReview(); }
  if (viewName === "graphs") renderGraphs();
  if (viewName === "discover") renderDiscover();
  if (viewName === "translator") renderTranslator();
  if (viewName === "settings") syncSettingsControls();
}

export function ensureCurrentText() {
  if (state.currentTextId && getTextById(state.currentTextId)) return;
  const lastTextId = getLastReadTextId();
  if (lastTextId && getTextById(lastTextId)) {
    state.currentTextId = lastTextId;
    state.selectedWord = null;
    saveState();
    return;
  }
  const shouldSave = Boolean(state.currentTextId || state.selectedWord || state.currentView === "reader");
  state.currentTextId = null;
  state.selectedWord = null;
  if (state.currentView === "reader") state.currentView = "library";
  if (shouldSave) saveState();
}

export { updateReaderSelection };
