import { buildSavePayload, saveToLocalStorage, saveWithRetry, saveSyncXhr } from "../api.js";

type SaveResult = WhBridgeSaveResult | void;

const TRANSIENT_ROOT_KEYS = new Set<PropertyKey>([
  "dataDirectory",
  "recoveryStatus"
]);

const BRIDGE_UI_ROOT_KEYS = new Set<PropertyKey>([
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
]);

export function createAutosave(getState: () => WhAppState) {
  const proxyCache = new WeakMap<object, object>();
  const bridgeUiTargets = new WeakSet<object>();
  const vocabularyMaps = new WeakSet<object>();
  const vocabularyEntries = new WeakSet<object>();
  let rootTarget: object | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suspendAutoSave = 0;
  let saveInFlight = false;
  let savePromise: Promise<SaveResult> = Promise.resolve();
  let savePending = false;
  let retryDelayMs = 0;
  let exclusiveWriteActive = false;
  let exclusiveWriteTail: Promise<unknown> = Promise.resolve();
  let queuedSavePromise: Promise<SaveResult> | null = null;
  let resolveQueuedSave: ((value: SaveResult | PromiseLike<SaveResult>) => void) | null;
  let rejectQueuedSave: ((reason?: any) => void) | null;
  let durableStateRevision = 0;
  let vocabularyRevision = 0;
  let lastMutationAt = 0;
  let lastSaveSucceededAt = 0;

  function hasPendingChanges(): boolean {
    return lastMutationAt > lastSaveSucceededAt
      || saveInFlight
      || savePending
      || saveTimer !== null;
  }

  function rawState(): WhAppState {
    const state = getState();
    return state._raw || state;
  }

  function syncProfilePreferences(): void {
    const current = rawState();
    const profile = current.profiles?.[current.preferences?.learningLanguage];
    if (profile) {
      profile.preferences = profile.preferences || {};
      profile.preferences.dictionaryUrl = current.preferences.dictionaryUrl;
      profile.preferences.dictionaryMode = current.preferences.dictionaryMode;
      profile.preferences.translationSourceLanguage = current.preferences.translationSourceLanguage;
      profile.preferences.translationTargetLanguage = current.preferences.translationTargetLanguage;
    }
  }

  function unwrapProxy<T>(value: T): T {
    const raw = value && typeof value === "object" ? (value as WhRecord)._raw : undefined;
    return (raw || value) as T;
  }

  function scheduleSave(delayMs = 200): void {
    lastMutationAt = Date.now();
    if (suspendAutoSave > 0) return;
    if (exclusiveWriteActive) {
      savePending = true;
      return;
    }
    if (saveInFlight) {
      savePending = true;
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      doSave().catch(() => {});
    }, delayMs);
  }

  function applyBackendSaveStatus(result: SaveResult): void {
    if (!result || typeof result !== "object") return;
    const current = rawState();
    if (Object.hasOwn(result, "recoveryStatus")) current.recoveryStatus = result.recoveryStatus;
  }

  function doSave(): Promise<SaveResult> {
    const current = rawState();
    syncProfilePreferences();
    if (!window.__qtBridge) {
      try {
        saveToLocalStorage(current);
        lastSaveSucceededAt = Date.now();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    saveInFlight = true;
    savePromise = saveWithRetry(JSON.stringify(buildSavePayload(current)), 3).then((result) => {
      applyBackendSaveStatus(result);
      retryDelayMs = 0;
      lastSaveSucceededAt = Date.now();
      saveInFlight = false;
      if (savePending) {
        savePending = false;
        return doSave();
      }
      return result;
    }).catch((error) => {
      saveInFlight = false;
      console.error("bridge save failed after retries", error);
      savePending = false;
      retryDelayMs = retryDelayMs ? Math.min(retryDelayMs * 2, 30000) : 1000;
      window.dispatchEvent(new CustomEvent("wordhunter:state-save-error", { detail: { retryDelayMs } }));
      scheduleSave(retryDelayMs);
      throw error;
    });
    return savePromise;
  }

  function saveState(): Promise<SaveResult> {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (exclusiveWriteActive) {
      savePending = true;
      if (!queuedSavePromise) {
        queuedSavePromise = new Promise<SaveResult>((resolve, reject) => {
          resolveQueuedSave = resolve;
          rejectQueuedSave = reject;
        });
      }
      return queuedSavePromise;
    }
    if (saveInFlight) {
      savePending = true;
      return savePromise;
    }
    return doSave();
  }

  function runExclusiveWrite<T>(
    callback: () => T | Promise<T>,
    { saveFirst = true }: { saveFirst?: boolean } = {}
  ): Promise<T> {
    const operation = exclusiveWriteTail.then(async () => {
      if (saveFirst) {
        await saveState();
      } else {
        if (saveInFlight) {
          try {
            await savePromise;
          } catch {
            // A confirmed backup restore may repair the state that autosave could not persist.
          }
        }
        clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
      }
      exclusiveWriteActive = true;
      try {
        return await callback();
      } finally {
        exclusiveWriteActive = false;
        try {
          if (savePending) {
            savePending = false;
            const result = await doSave();
            resolveQueuedSave?.(result);
          }
        } catch (error) {
          rejectQueuedSave?.(error);
          throw error;
        } finally {
          queuedSavePromise = null;
          resolveQueuedSave = null;
          rejectQueuedSave = null;
        }
      }
    });
    exclusiveWriteTail = operation.catch(() => {});
    return operation;
  }

  function isUiMutation(object: object, prop: PropertyKey): boolean {
    return bridgeUiTargets.has(object)
      || (object === rootTarget && BRIDGE_UI_ROOT_KEYS.has(prop));
  }

  function recordVocabularyMutation(object: object, prop: PropertyKey): void {
    if ((object === rootTarget && prop === "vocab")
      || vocabularyMaps.has(object)
      || (vocabularyEntries.has(object) && prop === "status")) {
      vocabularyRevision += 1;
    }
  }

  function wrap<T extends object>(target: T, bridgeUiOnly = false): T {
    if (!rootTarget) rootTarget = target;
    if (bridgeUiOnly) bridgeUiTargets.add(target);
    if (proxyCache.has(target)) return proxyCache.get(target) as T;
    const proxy = new Proxy(target, {
      get(object, prop, receiver) {
        if (prop === "_raw") return object;
        const value = Reflect.get(object, prop, receiver);
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          const childIsBridgeUi = bridgeUiTargets.has(object)
            || (object === rootTarget && BRIDGE_UI_ROOT_KEYS.has(prop));
          if (prop === "vocab") vocabularyMaps.add(value);
          else if (vocabularyMaps.has(object)) vocabularyEntries.add(value);
          return proxyCache.get(value) || wrap(value, childIsBridgeUi);
        }
        return value;
      },
      set(object, prop, value, receiver) {
        const oldValue = Reflect.get(object, prop, receiver);
        const rawValue = unwrapProxy(value);
        const result = Reflect.set(object, prop, rawValue, receiver);
        if (oldValue !== rawValue) recordVocabularyMutation(object, prop);
        if (oldValue !== rawValue
          && !(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
          && !isUiMutation(object, prop)) {
          if (suspendAutoSave === 0) durableStateRevision += 1;
          scheduleSave();
        }
        return result;
      },
      deleteProperty(object, prop) {
        if (prop in object) {
          Reflect.deleteProperty(object, prop);
          recordVocabularyMutation(object, prop);
          if (!(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
            && !isUiMutation(object, prop)) {
            if (suspendAutoSave === 0) durableStateRevision += 1;
            scheduleSave();
          }
        }
        return true;
      }
    });
    proxyCache.set(target, proxy);
    return proxy as T;
  }

  return {
    wrap,
    saveState,
    runExclusiveWrite,
    getDurableStateRevision() {
      return durableStateRevision;
    },
    getVocabularyRevision() {
      return vocabularyRevision;
    },
    markDurableStateReplaced() {
      durableStateRevision += 1;
      vocabularyRevision += 1;
    },
    flushPendingSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (exclusiveWriteActive) {
        savePending = true;
        return;
      }
      // The autosave debounce already persisted everything when nothing
      // changed since the last successful save — skip the redundant full
      // serialization (a multi-megabyte JSON.stringify) that used to make
      // window shutdown hang for seconds.
      if (!hasPendingChanges()) return;
      const current = rawState();
      syncProfilePreferences();
      if (window.__qtBridge) saveSyncXhr(JSON.stringify(buildSavePayload(current)));
      else saveToLocalStorage(current);
    },
    hasPendingChanges,
    withoutAutoSave<T>(callback: () => T): T {
      suspendAutoSave++;
      try { return callback(); } finally { suspendAutoSave--; }
    }
  };
}
