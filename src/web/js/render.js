// Render orchestrator.
import { state, saveUiState, getLastReadTextId } from "./state.js";
import { renderShell } from "./views/shell.js";
import { renderLibrary } from "./views/library.js";
import { renderReader, getTextById } from "./reader/renderer.js";
import { updateReaderSelection } from "./reader/selection.js";
import { rememberReaderScrollPosition } from "./reader/scroll.js";
import { renderVocabulary, renderReview } from "./views/vocabulary.js";
import { renderDiscover } from "./views/discover.js";
import { renderGraphs } from "./views/graphs.js";
import { renderTranslator } from "./views/translator.js";
import { syncSettingsControls } from "./preferences.js";
import { t } from "./i18n.js";
import { els } from "./dom.js";
import { applyPlatformUi, isAndroidPlatform } from "./platform.js";

let ocrGpuStatus;
let ocrGpuProbe;
let navigationEpoch = 0;

const VIEW_RENDERERS = {
  library: () => renderLibrary(),
  reader: () => renderReader(),
  vocabulary: () => { renderVocabulary(); renderReview(); },
  flashcards: () => renderReview(),
  graphs: () => renderGraphs(),
  discover: () => renderDiscover(),
  translator: () => renderTranslator(),
  sync: () => { syncSettingsControls(); applyPlatformUi(); },
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
  navigationEpoch += 1;
  if (state.currentView === "reader" && viewName !== "reader") {
    rememberReaderScrollPosition();
    if (state.currentTextId) {
      if (!state.readerPages) state.readerPages = {};
      state.readerPages[state.currentTextId] = state.readerPage;
    }
  }
  state.currentView = viewName;
  saveUiState();
  renderShell();
  renderView(viewName);
  window.dispatchEvent(new CustomEvent("wordhunter:view-changed", { detail: { view: viewName } }));
}

export function getNavigationEpoch() {
  return navigationEpoch;
}

function refreshOcrGpuStatus() {
  if (!ocrGpuStatus && !ocrGpuProbe) {
    ocrGpuProbe = fetch("/__ocr/gpu-status")
      .then((response) => response.ok ? response.json() : { status: "failed" })
      .catch(() => ({ status: "failed" }))
      .then(({ status, provider }) => {
        ocrGpuStatus = {
          status: status === "ready" || status === "unavailable" ? status : "failed",
          provider: provider === "webgpu" || provider === "directml" ? provider : "cpu"
        };
        renderOcrGpuStatus();
      });
  }
  renderOcrGpuStatus();
}

function renderOcrGpuStatus() {
  const key = ocrGpuStatus?.status === "ready"
    ? (ocrGpuStatus.provider === "webgpu" ? "settings.ocrGpuReadyWebGpu" : "settings.ocrGpuReady")
    : ocrGpuStatus?.status === "unavailable"
      ? "settings.ocrGpuUnavailable"
      : ocrGpuStatus?.status === "failed"
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
    saveUiState();
    return;
  }
  const shouldSave = Boolean(state.currentTextId || state.selectedWord || state.currentView === "reader");
  state.currentTextId = null;
  state.selectedWord = null;
  if (state.currentView === "reader") state.currentView = "library";
  if (shouldSave) saveUiState();
}

export { updateReaderSelection };
