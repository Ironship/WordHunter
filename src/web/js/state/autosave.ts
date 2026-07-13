import { buildSavePayload, saveToLocalStorage, saveWithRetry, saveSyncXhr } from "../api.js";

type SaveResult = WhBridgeSaveResult | void;

const TRANSIENT_ROOT_KEYS = new Set<PropertyKey>([
  "syncHealth",
  "cloudSyncStatus",
  "syncthingStatus",
  "syncConflictCount",
  "syncConflicts",
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
    if (Object.hasOwn(result, "syncHealth")) current.syncHealth = result.syncHealth;
    if (Object.hasOwn(result, "syncConflictCount")) current.syncConflictCount = result.syncConflictCount;
    if (Object.hasOwn(result, "syncConflicts")) current.syncConflicts = result.syncConflicts;
  }

  function doSave(): Promise<SaveResult> {
    const current = rawState();
    syncProfilePreferences();
    if (!window.__qtBridge) {
      saveToLocalStorage(current);
      return Promise.resolve();
    }
    saveInFlight = true;
    savePromise = saveWithRetry(JSON.stringify(buildSavePayload(current)), 3).then((result) => {
      applyBackendSaveStatus(result);
      retryDelayMs = 0;
      saveInFlight = false;
      window.dispatchEvent(new CustomEvent("wordhunter:sync-saved", { detail: { ...result, time: new Date().toLocaleTimeString() } }));
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
      window.dispatchEvent(new CustomEvent("wordhunter:sync-error", { detail: { retryDelayMs } }));
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

  function runExclusiveWrite<T>(callback: () => T | Promise<T>): Promise<T> {
    if (exclusiveWriteActive) {
      return Promise.reject(new Error("nested exclusive state write is not supported"));
    }
    const operation = exclusiveWriteTail.then(async () => {
      await saveState();
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

  function isBridgeUiMutation(object: object, prop: PropertyKey): boolean {
    return Boolean(window.__qtBridge && (
      bridgeUiTargets.has(object)
      || (object === rootTarget && BRIDGE_UI_ROOT_KEYS.has(prop))
    ));
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
          return proxyCache.get(value) || wrap(value, childIsBridgeUi);
        }
        return value;
      },
      set(object, prop, value, receiver) {
        const oldValue = Reflect.get(object, prop, receiver);
        const rawValue = unwrapProxy(value);
        const result = Reflect.set(object, prop, rawValue, receiver);
        if (oldValue !== rawValue
          && !(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
          && !isBridgeUiMutation(object, prop)) scheduleSave();
        return result;
      },
      deleteProperty(object, prop) {
        if (prop in object) {
          Reflect.deleteProperty(object, prop);
          if (!(object === rootTarget && TRANSIENT_ROOT_KEYS.has(prop))
            && !isBridgeUiMutation(object, prop)) scheduleSave();
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
    flushPendingSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (exclusiveWriteActive) {
        savePending = true;
        return;
      }
      const current = rawState();
      syncProfilePreferences();
      if (window.__qtBridge) saveSyncXhr(JSON.stringify(buildSavePayload(current)));
      else saveToLocalStorage(current);
    },
    withoutAutoSave<T>(callback: () => T): T {
      suspendAutoSave++;
      try { return callback(); } finally { suspendAutoSave--; }
    }
  };
}
