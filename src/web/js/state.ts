// @ts-check

import { createAutosave } from "./state/autosave.js";
import { getDefaultDictionaryUrl } from "./state/defaults.js";
import { assertSupportedStateSchemaVersion, loadState } from "./state/normalize.js";
import { captureUiState, saveUiStateCache, UI_STATE_KEYS } from "./state/ui-cache.js";
import { OTHER_PROFILE_ID, STATE_SCHEMA_VERSION } from "./constants.js";
import { postStoreJson } from "./store-bridge.js";

export { STATE_SCHEMA_VERSION } from "./constants.js";
export { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./state/defaults.js";
export { normalizeState } from "./state/normalize.js";

let stateRef: WhAppState;
const autosave = createAutosave(() => stateRef);
export const state: WhAppState = stateRef = autosave.wrap(loadState());
export const initialVocabKeys = new Set(Object.keys(state.vocab || {}));
const frontendStateFlushers = new Set<() => unknown>();
const bridgeSnapshotHandlers = new Set<(change: WhBridgeSnapshotChange) => unknown>();
let uiSaveQueue: Promise<WhRecord | void> = Promise.resolve();
const inFlightUiSaves = new Set<Promise<unknown>>();
let uiWritesPaused = 0;
let uiSaveRequestedWhilePaused = false;

function trackUiSave<T>(promise: Promise<T>): Promise<T> {
  inFlightUiSaves.add(promise);
  void promise.then(
    () => inFlightUiSaves.delete(promise),
    () => inFlightUiSaves.delete(promise)
  );
  return promise;
}

async function drainUiSaves(): Promise<void> {
  await uiSaveQueue;
  while (inFlightUiSaves.size) {
    await Promise.allSettled([...inFlightUiSaves]);
  }
}

function rawState(): WhAppState {
  return state._raw || state;
}

function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function captureLocalUiState(): WhRecord {
  const raw = rawState();
  const captured = captureUiState(raw);
  if (raw.discover) captured.discover = clonePlain(raw.discover);
  return captured;
}

function postCurrentUiState(): Promise<WhRecord> {
  const payload = { schemaVersion: STATE_SCHEMA_VERSION, ...captureUiState(rawState()) };
  saveUiStateCache(rawState());
  return postStoreJson("/__store/ui_state", payload);
}

function restoreLocalUiState(nextState: WhAppState, captured: WhRecord): void {
  for (const key of UI_STATE_KEYS) {
    if (captured[key] !== undefined) (nextState as WhRecord)[key] = captured[key];
  }
  if (captured.discover && !nextState.discover) nextState.discover = captured.discover;
}

export function saveState(): Promise<WhBridgeSaveResult | void> {
  return autosave.saveState();
}

export function saveUiState(): Promise<WhBridgeSaveResult | void> {
  if (window.__qtBridge) {
    if (uiWritesPaused > 0) {
      uiSaveRequestedWhilePaused = true;
      return uiSaveQueue;
    }
    uiSaveQueue = uiSaveQueue
      .catch(() => {})
      .then(postCurrentUiState)
      .catch((error) => console.warn("Failed to save Reader UI state", error));
    return uiSaveQueue;
  }
  return saveState();
}

export function flushUiStateSync(): void {
  if (!window.__qtBridge) return;
  if (uiWritesPaused > 0) {
    uiSaveRequestedWhilePaused = true;
    return;
  }
  const payload = { schemaVersion: STATE_SCHEMA_VERSION, ...captureUiState(rawState()) };
  saveUiStateCache(rawState());
  try {
    const request = fetch("/__store/ui_state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WH-Token": window.WH_TOKEN || ""
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch((error) => console.warn("Failed to flush Reader UI state", error));
    trackUiSave(request);
  } catch (error) {
    console.warn("Failed to flush Reader UI state", error);
  }
}

export function getDurableStateRevision(): number {
  return autosave.getDurableStateRevision();
}

export function registerFrontendStateFlusher(flusher: () => unknown): () => boolean | void {
  if (typeof flusher !== "function") return () => {};
  frontendStateFlushers.add(flusher);
  return () => frontendStateFlushers.delete(flusher);
}

export function flushFrontendStateBuffers(): void {
  for (const flusher of [...frontendStateFlushers]) {
    try {
      flusher();
    } catch (error) {
      console.warn("frontend state flusher failed", error);
    }
  }
}

export function registerBridgeSnapshotHandler(handler: (change: WhBridgeSnapshotChange) => unknown): () => boolean | void {
  if (typeof handler !== "function") return () => {};
  bridgeSnapshotHandlers.add(handler);
  return () => bridgeSnapshotHandlers.delete(handler);
}

export async function flushAllPendingFrontendState(): Promise<void> {
  flushFrontendStateBuffers();
  await Promise.all([saveState(), drainUiSaves()]);
}
window.flushAllPendingFrontendState = flushAllPendingFrontendState;

let nativeCloseRequested = false;
export async function requestWordHunterClose(): Promise<void> {
  if (nativeCloseRequested) return;
  nativeCloseRequested = true;
  flushFrontendStateBuffers();
  const finalUiSave = window.__qtBridge ? drainUiSaves().then(postCurrentUiState) : Promise.resolve();
  const results = await Promise.allSettled([saveState(), finalUiSave]);
  const saveFailed = results.some((result) => result.status === "rejected");
  if (saveFailed) {
    nativeCloseRequested = false;
    console.warn("Word Hunter remains open because final state saving failed");
    void Promise.all([import("./toast.js"), import("./i18n.js")])
      .then(([{ showToast }, { t }]) => showToast(t("toast.syncUnavailable"), "error"));
    return;
  }
  try {
    const response = await fetch("/__app/close", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: "{}"
    });
    if (!response.ok) throw new Error(`close HTTP ${response.status}`);
  } catch (error) {
    nativeCloseRequested = false;
    console.warn("Failed to close Word Hunter after saving state", error);
  }
}
window.requestWordHunterClose = () => { void requestWordHunterClose(); };

export function runExclusiveStateWrite<T>(callback: () => T | Promise<T>): Promise<T> {
  flushFrontendStateBuffers();
  uiWritesPaused += 1;
  return drainUiSaves()
    .then(() => autosave.runExclusiveWrite(callback))
    .finally(() => {
      uiWritesPaused = Math.max(0, uiWritesPaused - 1);
      if (uiWritesPaused === 0 && uiSaveRequestedWhilePaused) {
        uiSaveRequestedWhilePaused = false;
        void saveUiState();
      }
    });
}

export function applyBridgeSnapshotToState(
  snapshot: unknown,
  {
    expectedRevision,
    preserveActiveReader = false,
    preserveLocalUi = true
  }: { expectedRevision?: number; preserveActiveReader?: boolean; preserveLocalUi?: boolean } = {}
): boolean {
  assertSupportedStateSchemaVersion(snapshot, "bridge snapshot");
  if (expectedRevision !== undefined && autosave.getDurableStateRevision() !== expectedRevision) return false;
  const localUi = preserveLocalUi ? captureLocalUiState() : null;
  const previousTextIds = new Set((state.customTexts || []).map((text) => text?.id).filter((id): id is string => Boolean(id)));
  const snapshotPreferences = snapshot.prefs !== null && typeof snapshot.prefs === "object" && !Array.isArray(snapshot.prefs)
    ? snapshot.prefs as WhRecord
    : {};
  if (!snapshotPreferences.__discover && state.discover) {
    snapshot.prefs = { ...snapshotPreferences, __discover: { ...state.discover } };
  }
  if (!snapshot?.cloudSyncStatus && state.cloudSyncStatus) {
    snapshot.cloudSyncStatus = clonePlain(rawState().cloudSyncStatus);
  }
  window.__bridgeState = snapshot;
  const nextState = loadState();
  if (localUi) restoreLocalUiState(nextState, localUi);
  replaceState(nextState, { save: false });
  autosave.markDurableStateReplaced();
  const currentTextIds = new Set((state.customTexts || []).map((text) => text?.id).filter((id): id is string => Boolean(id)));
  const textIds = new Set([...previousTextIds, ...currentTextIds]);
  for (const handler of [...bridgeSnapshotHandlers]) {
    try {
      handler({ textIds, preserveActiveReader, previousTextIds, currentTextIds });
    } catch (error) {
      console.warn("bridge snapshot handler failed", error);
    }
  }
  return true;
}

function flushPendingSave(): void {
  autosave.flushPendingSave();
}
window.flushPendingSave = flushPendingSave;

export function resetInitialVocabKeys(): void {
  initialVocabKeys.clear();
  Object.keys(state.vocab || {}).forEach((key) => initialVocabKeys.add(key));
}

export function getLastReadTextId(lang = state.preferences?.learningLanguage): string | null {
  if (!lang) return null;
  const map = state.preferences?.lastReadTextIds;
  return map && typeof map === "object" ? map[lang] || null : null;
}

export function setLastReadTextId(id: string, lang = state.preferences?.learningLanguage): void {
  if (!id || !lang) return;
  if (!state.preferences.lastReadTextIds || typeof state.preferences.lastReadTextIds !== "object") state.preferences.lastReadTextIds = {};
  state.preferences.lastReadTextIds[lang] = id;
}

export function clearLastReadTextId(id: string, lang = state.preferences?.learningLanguage): void {
  if (!id || !lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object" && map[lang] === id) delete map[lang];
}

export function clearLastReadTextForLanguage(lang = state.preferences?.learningLanguage): void {
  if (!lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object") delete map[lang];
}

export function replaceState(nextState: WhAppState, { save = true }: { save?: boolean } = {}): void {
  autosave.withoutAutoSave(() => {
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, nextState);
  });
  resetInitialVocabKeys();
  if (save) saveState();
  if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("wordhunter:state-replaced"));
  }
}

export function switchLearningLanguage(lang: string): void {
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
    previousProfile.preferences.translationSourceLanguage = state.preferences.translationSourceLanguage;
    previousProfile.preferences.translationTargetLanguage = state.preferences.translationTargetLanguage;
  }
  state.preferences.learningLanguage = lang;
  state.discover.page = 1;
  if (!state.profiles) state.profiles = {};
  if (!state.profiles[lang]) {
    state.profiles[lang] = {
      vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [],
      preferences: {
        dictionaryUrl: getDefaultDictionaryUrl(lang),
        dictionaryMode: "internal",
        translationSourceLanguage: "",
        translationTargetLanguage: lang === OTHER_PROFILE_ID ? state.preferences.locale || "en" : ""
      }
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
  state.preferences.translationSourceLanguage = active.preferences?.translationSourceLanguage || "";
  state.preferences.translationTargetLanguage = active.preferences?.translationTargetLanguage
    || (lang === OTHER_PROFILE_ID ? state.preferences.locale || "en" : "");
  state.currentTextId = null;
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  state.currentView = "library";
  state.readerPage = 1;
  resetInitialVocabKeys();
  saveState();
}
