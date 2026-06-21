import { buildSavePayload, saveToLocalStorage, saveWithRetry, saveSyncXhr } from "../api.js";

export function createAutosave(getState) {
  const proxyCache = new WeakMap();
  let saveTimer = null;
  let suspendAutoSave = 0;
  let saveInFlight = false;
  let savePending = false;

  function rawState() {
    const state = getState();
    return state._raw || state;
  }

  function syncProfilePreferences() {
    const current = rawState();
    const profile = current.profiles?.[current.preferences?.learningLanguage];
    if (profile) {
      profile.preferences = profile.preferences || {};
      profile.preferences.dictionaryUrl = current.preferences.dictionaryUrl;
    }
  }

  function unwrapProxy(value) {
    return value && typeof value === "object" && value._raw ? value._raw : value;
  }

  function scheduleSave() {
    if (suspendAutoSave > 0) return;
    if (saveInFlight) {
      savePending = true;
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 200);
  }

  function doSave() {
    const current = rawState();
    syncProfilePreferences();
    if (!window.__qtBridge) {
      saveToLocalStorage(current);
      return;
    }
    saveInFlight = true;
    saveWithRetry(JSON.stringify(buildSavePayload(current)), 3).then(() => {
      saveInFlight = false;
      if (savePending) {
        savePending = false;
        doSave();
      }
    }).catch((error) => {
      saveInFlight = false;
      console.error("bridge save failed after retries", error);
      savePending = false;
      scheduleSave();
    });
  }

  function wrap(target) {
    if (proxyCache.has(target)) return proxyCache.get(target);
    const proxy = new Proxy(target, {
      get(object, prop, receiver) {
        if (prop === "_raw") return object;
        const value = Reflect.get(object, prop, receiver);
        if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          return proxyCache.get(value) || wrap(value);
        }
        return value;
      },
      set(object, prop, value, receiver) {
        const oldValue = object[prop];
        const rawValue = unwrapProxy(value);
        const result = Reflect.set(object, prop, rawValue, receiver);
        if (oldValue !== rawValue) scheduleSave();
        return result;
      },
      deleteProperty(object, prop) {
        if (prop in object) {
          Reflect.deleteProperty(object, prop);
          scheduleSave();
        }
        return true;
      }
    });
    proxyCache.set(target, proxy);
    return proxy;
  }

  return {
    wrap,
    saveState() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (saveInFlight) {
        savePending = true;
        return;
      }
      doSave();
    },
    flushPendingSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      const current = rawState();
      syncProfilePreferences();
      if (window.__qtBridge) saveSyncXhr(JSON.stringify(buildSavePayload(current)));
      else saveToLocalStorage(current);
    },
    withoutAutoSave(callback) {
      suspendAutoSave++;
      try { return callback(); } finally { suspendAutoSave--; }
    }
  };
}
