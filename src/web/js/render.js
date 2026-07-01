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
import { t } from "./i18n.js";
import { els } from "./dom.js";
import { applyPlatformUi, isAndroidPlatform } from "./platform.js";

let ocrGpuStatus;
let ocrGpuProbe;

const VIEW_RENDERERS = {
  library: () => renderLibrary(),
  reader: () => renderReader(),
  vocabulary: () => { renderVocabulary(); renderReview(); },
  flashcards: () => renderReview(),
  graphs: () => renderGraphs(),
  discover: () => renderDiscover(),
  translator: () => renderTranslator(),
  settings: () => { syncSettingsControls(); applyPlatformUi(); if (!isAndroidPlatform()) refreshOcrGpuStatus(); },
  help: null
};

function renderView(viewName) {
  const fn = VIEW_RENDERERS[viewName];
  if (fn) fn();
}

export function render() {
  renderShell();
  renderView(state.currentView || "library");
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
  renderView(viewName);
}

function refreshOcrGpuStatus() {
  if (!ocrGpuStatus && !ocrGpuProbe) {
    ocrGpuProbe = fetch("/__ocr/gpu-status")
      .then((response) => response.ok ? response.json() : { status: "failed" })
      .catch(() => ({ status: "failed" }))
      .then(({ status }) => {
        ocrGpuStatus = status === "ready" || status === "unavailable" ? status : "failed";
        renderOcrGpuStatus();
      });
  }
  renderOcrGpuStatus();
}

function renderOcrGpuStatus() {
  const key = ocrGpuStatus === "ready"
    ? "settings.ocrGpuReady"
    : ocrGpuStatus === "unavailable"
      ? "settings.ocrGpuUnavailable"
      : ocrGpuStatus === "failed"
        ? "settings.ocrGpuFailed"
        : "settings.ocrGpuChecking";
  if (els.ocrGpuStatus) els.ocrGpuStatus.textContent = t(key);
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
