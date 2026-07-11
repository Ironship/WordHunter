import { createAutosave } from "./state/autosave.js";
import { getDefaultDictionaryUrl } from "./state/defaults.js";
import { loadState } from "./state/normalize.js";

export { STATE_SCHEMA_VERSION } from "./constants.js";
export { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./state/defaults.js";
export { normalizeState } from "./state/normalize.js";

let stateRef;
const autosave = createAutosave(() => stateRef);
export const state = stateRef = autosave.wrap(loadState());
export const initialVocabKeys = new Set(Object.keys(state.vocab || {}));
const frontendStateFlushers = new Set();
const bridgeSnapshotHandlers = new Set();

const UI_STATE_KEYS = [
  "currentView",
  "currentTextId",
  "selectedWord",
  "selectedWordIndex",
  "readerSelectionRange",
  "reviewIndex",
  "readerFontSize",
  "readerPdfZoom",
  "readerPdfViewMode",
  "readerPage",
  "readerPages",
  "readerScrolls",
  "readerScrollsPerPage",
  "filters"
];

function rawState() {
  return state._raw || state;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function captureLocalUiState() {
  const raw = rawState();
  const captured = {};
  for (const key of UI_STATE_KEYS) captured[key] = clonePlain(raw[key]);
  if (raw.discover) captured.discover = clonePlain(raw.discover);
  return captured;
}

function restoreLocalUiState(nextState, captured) {
  for (const key of UI_STATE_KEYS) {
    if (captured[key] !== undefined) nextState[key] = captured[key];
  }
  if (captured.discover && !nextState.discover) nextState.discover = captured.discover;
}

export function saveState() {
  return autosave.saveState();
}

export function saveUiState() {
  if (window.__qtBridge) return Promise.resolve();
  return saveState();
}

export function registerFrontendStateFlusher(flusher) {
  if (typeof flusher !== "function") return () => {};
  frontendStateFlushers.add(flusher);
  return () => frontendStateFlushers.delete(flusher);
}

export function flushFrontendStateBuffers() {
  for (const flusher of [...frontendStateFlushers]) {
    try {
      flusher();
    } catch (error) {
      console.warn("frontend state flusher failed", error);
    }
  }
}

export function registerBridgeSnapshotHandler(handler) {
  if (typeof handler !== "function") return () => {};
  bridgeSnapshotHandlers.add(handler);
  return () => bridgeSnapshotHandlers.delete(handler);
}

export async function flushAllPendingFrontendState() {
  flushFrontendStateBuffers();
  await saveState();
}
window.flushAllPendingFrontendState = flushAllPendingFrontendState;

export function runExclusiveStateWrite(callback) {
  flushFrontendStateBuffers();
  return autosave.runExclusiveWrite(callback);
}

export function applyBridgeSnapshotToState(snapshot) {
  const localUi = captureLocalUiState();
  const previousTextIds = new Set((state.customTexts || []).map((text) => text?.id).filter(Boolean));
  if (!snapshot?.prefs?.__discover && state.discover) {
    snapshot.prefs = { ...(snapshot.prefs || {}), __discover: { ...state.discover } };
  }
  if (!snapshot?.cloudSyncStatus && state.cloudSyncStatus) {
    snapshot.cloudSyncStatus = clonePlain(rawState().cloudSyncStatus);
  }
  window.__bridgeState = snapshot;
  const nextState = loadState();
  restoreLocalUiState(nextState, localUi);
  replaceState(nextState, { save: false });
  const currentTextIds = new Set((state.customTexts || []).map((text) => text?.id).filter(Boolean));
  const textIds = new Set([...previousTextIds, ...currentTextIds]);
  for (const handler of [...bridgeSnapshotHandlers]) {
    try {
      handler({ textIds, previousTextIds, currentTextIds });
    } catch (error) {
      console.warn("bridge snapshot handler failed", error);
    }
  }
}

function flushPendingSave() {
  autosave.flushPendingSave();
}
window.flushPendingSave = flushPendingSave;

export function resetInitialVocabKeys() {
  initialVocabKeys.clear();
  Object.keys(state.vocab || {}).forEach((key) => initialVocabKeys.add(key));
}

export function getLastReadTextId(lang = state.preferences?.learningLanguage) {
  if (!lang) return null;
  const map = state.preferences?.lastReadTextIds;
  return map && typeof map === "object" ? map[lang] || null : null;
}

export function setLastReadTextId(id, lang = state.preferences?.learningLanguage) {
  if (!id || !lang) return;
  if (!state.preferences.lastReadTextIds || typeof state.preferences.lastReadTextIds !== "object") state.preferences.lastReadTextIds = {};
  state.preferences.lastReadTextIds[lang] = id;
}

export function clearLastReadTextId(id, lang = state.preferences?.learningLanguage) {
  if (!id || !lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object" && map[lang] === id) delete map[lang];
}

export function clearLastReadTextForLanguage(lang = state.preferences?.learningLanguage) {
  if (!lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object") delete map[lang];
}

export function replaceState(nextState, { save = true } = {}) {
  autosave.withoutAutoSave(() => {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, nextState);
  });
  resetInitialVocabKeys();
  if (save) saveState();
}

export function switchLearningLanguage(lang) {
  const previousLang = state.preferences?.learningLanguage;
  const previousProfile = state.profiles?.[previousLang];
  if (previousProfile) {
    previousProfile.vocab = state.vocab || {};
    previousProfile.customTexts = state.customTexts || [];
    previousProfile.userBooks = state.userBooks || [];
    previousProfile.hiddenBuiltInBooks = state.hiddenBuiltInBooks || [];
    previousProfile.archivedBookIds = state.archivedBookIds || [];
    previousProfile.preferences = previousProfile.preferences || {};
    previousProfile.preferences.dictionaryUrl = state.preferences.dictionaryUrl;
    previousProfile.preferences.dictionaryMode = state.preferences.dictionaryMode;
  }
  state.preferences.learningLanguage = lang;
  state.discover.page = 1;
  if (!state.profiles) state.profiles = {};
  if (!state.profiles[lang]) {
    state.profiles[lang] = {
      vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [],
      preferences: { dictionaryUrl: getDefaultDictionaryUrl(lang), dictionaryMode: "internal", theme: "familiar" }
    };
  }
  const active = state.profiles[lang];
  active.vocab = active.vocab || {};
  active.customTexts = active.customTexts || [];
  active.userBooks = active.userBooks || [];
  active.hiddenBuiltInBooks = active.hiddenBuiltInBooks || [];
  active.preferences = active.preferences || {};
  state.vocab = active.vocab;
  state.customTexts = active.customTexts;
  state.userBooks = active.userBooks;
  state.hiddenBuiltInBooks = active.hiddenBuiltInBooks;
  active.archivedBookIds = Array.isArray(active.archivedBookIds) ? active.archivedBookIds : [];
  state.archivedBookIds = active.archivedBookIds;
  state.preferences.dictionaryUrl = active.preferences?.dictionaryUrl || getDefaultDictionaryUrl(lang);
  state.preferences.dictionaryMode = active.preferences?.dictionaryMode || "internal";
  state.currentTextId = null;
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  state.currentView = "library";
  state.readerPage = 1;
  state.readerPages = {};
  state.readerScrolls = {};
  resetInitialVocabKeys();
  saveState();
}
