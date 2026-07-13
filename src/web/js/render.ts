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

type ViewName = "library" | "reader" | "vocabulary" | "flashcards" | "graphs" | "discover" | "translator" | "sync" | "settings" | "help";
type ViewRenderer = (() => void) | null;
type OcrGpuState = "ready" | "unavailable" | "failed";
type OcrGpuProvider = "webgpu" | "directml" | "cpu";

interface OcrGpuStatus {
  status: OcrGpuState;
  provider: OcrGpuProvider;
}

type UnknownRecord = Record<string, unknown>;

let ocrGpuStatus: OcrGpuStatus | undefined;
let ocrGpuProbe: Promise<void> | undefined;
let navigationEpoch = 0;

const VIEW_RENDERERS: Record<ViewName, ViewRenderer> = {
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

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isViewName(value: string): value is ViewName {
  return Object.hasOwn(VIEW_RENDERERS, value);
}

function normalizeOcrGpuStatus(value: unknown): OcrGpuStatus {
  const result = isRecord(value) ? value : {};
  return {
    status: result.status === "ready" || result.status === "unavailable" ? result.status : "failed",
    provider: result.provider === "webgpu" || result.provider === "directml" ? result.provider : "cpu"
  };
}

function renderView(viewName: string): void {
  if (!isViewName(viewName)) return;
  const fn = VIEW_RENDERERS[viewName];
  if (fn) fn();
}

export function render(): void {
  renderShell();
  renderView(state.currentView || "library");
}

export function setView(viewName: string): void {
  navigationEpoch += 1;
  document.documentElement.classList.remove("pocket-navigation-open", "pocket-import-open", "pocket-word-panel-open");
  for (const id of ["pocket-navigation-toggle", "reader-pocket-navigation-toggle", "library-import-toggle"]) {
    document.getElementById(id)?.setAttribute("aria-expanded", "false");
  }
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

export function getNavigationEpoch(): number {
  return navigationEpoch;
}

function refreshOcrGpuStatus(): void {
  if (!ocrGpuStatus && !ocrGpuProbe) {
    ocrGpuProbe = fetch("/__ocr/gpu-status")
      .then(async (response): Promise<unknown> => response.ok ? response.json() : { status: "failed" })
      .catch((): unknown => ({ status: "failed" }))
      .then((result) => {
        ocrGpuStatus = normalizeOcrGpuStatus(result);
        renderOcrGpuStatus();
      });
  }
  renderOcrGpuStatus();
}

function renderOcrGpuStatus(): void {
  const key = ocrGpuStatus?.status === "ready"
    ? (ocrGpuStatus.provider === "webgpu" ? "settings.ocrGpuReadyWebGpu" : "settings.ocrGpuReady")
    : ocrGpuStatus?.status === "unavailable"
      ? "settings.ocrGpuUnavailable"
      : ocrGpuStatus?.status === "failed"
        ? "settings.ocrGpuFailed"
        : "settings.ocrGpuChecking";
  if (els.ocrGpuStatus) els.ocrGpuStatus.textContent = t(key);
}

export function ensureCurrentText(): void {
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
