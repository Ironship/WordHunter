import { createAutosave } from "./state/autosave.js";
import { getDefaultDictionaryUrl } from "./state/defaults.js";
import { loadState } from "./state/normalize.js";

export { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./state/defaults.js";
export { normalizeState } from "./state/normalize.js";

let stateRef;
const autosave = createAutosave(() => stateRef);
export const state = stateRef = autosave.wrap(loadState());
export const initialVocabKeys = new Set(Object.keys(state.vocab || {}));

export function saveState() {
  autosave.saveState();
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

export function replaceState(nextState) {
  autosave.withoutAutoSave(() => {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, nextState);
  });
  resetInitialVocabKeys();
  saveState();
}

export function switchLearningLanguage(lang) {
  flushPendingSave();
  state.preferences.learningLanguage = lang;
  state.discover.language = lang;
  if (!state.profiles) state.profiles = {};
  if (!state.profiles[lang]) {
    state.profiles[lang] = {
      vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [],
      preferences: { dictionaryUrl: getDefaultDictionaryUrl(lang), dictionaryMode: "internal" }
    };
  }
  const active = state.profiles[lang];
  state.vocab = active.vocab;
  state.customTexts = active.customTexts;
  state.userBooks = active.userBooks;
  state.hiddenBuiltInBooks = active.hiddenBuiltInBooks;
  active.archivedBookIds = Array.isArray(active.archivedBookIds) ? active.archivedBookIds : [];
  state.archivedBookIds = active.archivedBookIds;
  state.preferences.dictionaryUrl = active.preferences?.dictionaryUrl || getDefaultDictionaryUrl(lang);
  state.currentTextId = null;
  state.selectedWord = null;
  state.readerSelectionRange = null;
  state.currentView = "library";
  state.readerPage = 1;
  state.readerPages = {};
  state.readerScrolls = {};
  resetInitialVocabKeys();
  saveState();
}
