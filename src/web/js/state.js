import { STORAGE_KEY } from "./constants.js";
import { clamp } from "./utils.js";

const VOCAB_STATUS_FILTERS = ["new", "learning", "known", "ignored"];

function normalizeVocabStatusFilters(value, legacyValue) {
  if (Array.isArray(value)) {
    return value.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  }
  if (legacyValue === "all") return [...VOCAB_STATUS_FILTERS];
  if (legacyValue === "not_ignored") return ["new", "learning", "known"];
  if (VOCAB_STATUS_FILTERS.includes(legacyValue)) return [legacyValue];
  return [...VOCAB_STATUS_FILTERS];
}

function normalizeAnkiExportStatuses(value) {
  if (!Array.isArray(value)) return ["learning"];
  const statuses = value.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  return statuses.length ? statuses : ["learning"];
}

function getDefaultDictionaryUrl(lang) {
  const urls = {
    en: "https://www.diki.pl/slownik-angielskiego?q={{word}}",
    de: "https://www.diki.pl/slownik-niemieckiego?q={{word}}",
    es: "https://www.diki.pl/slownik-hiszpanskiego?q={{word}}",
    it: "https://www.diki.pl/slownik-wloskiego?q={{word}}",
    fr: "https://www.diki.pl/slownik-francuskiego?q={{word}}",
    pl: "https://sjp.pwn.pl/szukaj/{{word}}.html",
    uk: "https://translate.google.com/?sl=uk&tl=pl&text={{word}}&op=translate",
    ru: "https://translate.google.com/?sl=ru&tl=pl&text={{word}}&op=translate",
    ja: "https://jisho.org/search/{{word}}"
  };
  return urls[lang] || urls.en;
}

export function createDefaultState() {
  return {
    currentView: "library",
    currentTextId: null,
    selectedWord: null,
    readerSelectionRange: null,
    customTexts: [],
    userBooks: [],
    hiddenBuiltInBooks: [],
    archivedBookIds: [],
    vocab: {},
    profiles: null,
    reviewIndex: 0,
    readerFontSize: 18,
    readerPage: 1,
    readerPages: {},
    readerScrolls: {},
    filters: {
      libraryQuery: "",
      libraryLevel: "all",
      librarySort: "title",
      librarySortReverse: false,
      libraryArchive: "active",
      vocabQuery: "",
      vocabStatus: "all",
      vocabStatuses: ["new", "learning", "known", "ignored"],
      vocabTextId: "all"
    },
    discover: {
      query: "",
      source: "gutenberg",
      language: "de",
      sort: "popular",
      level: "",
      page: 1
    },
    preferences: {
      theme: "auto",
      locale: "en",
      readerFont: "serif",
      readerLineHeight: "normal",
      highlightTokens: true,
      hideKnownIgnored: true,
      autoLearnOnClick: false,
      autoAddLearningOnly: true,
      showCardStats: true,
      showCovers: true,
      learningLanguage: "de",
      dictionaryUrl: "",
      dictionaryMode: "internal",
      readerTextAlign: "left",
      readerMaxWidth: "medium",
      ttsRate: "normal",
      autoTtsOnWordFocus: false,
      reviewReverse: false,
      srsAlgorithm: "sm2",
      removalBehavior: "ignored",
      useEdgeTts: false,
      autoTranslateWords: false,
      ankiExportStatuses: ["learning"],
      wordDetectionAlgorithm: "modern",
      lastReadTextIds: {},
      skippedVersion: "",
      disableUpdateCheck: false
    }
  };
}

export function getAllCustomTexts() {
  if (!state.profiles) return state.customTexts || [];
  const all = [];
  for (const p of Object.values(state.profiles)) {
    if (p.customTexts) all.push(...p.customTexts);
  }
  return all;
}

export function normalizeState(nextState) {
  const defaults = createDefaultState();
  nextState.customTexts = Array.isArray(nextState.customTexts) ? nextState.customTexts : [];
  nextState.userBooks = Array.isArray(nextState.userBooks) ? nextState.userBooks : [];
  nextState.hiddenBuiltInBooks = Array.isArray(nextState.hiddenBuiltInBooks) ? nextState.hiddenBuiltInBooks : [];
  nextState.archivedBookIds = Array.isArray(nextState.archivedBookIds) ? nextState.archivedBookIds : [];
  nextState.vocab = nextState.vocab && typeof nextState.vocab === "object" ? nextState.vocab : {};
  nextState.filters = { ...defaults.filters, ...(nextState.filters || {}) };
  nextState.filters.vocabStatuses = normalizeVocabStatusFilters(nextState.filters.vocabStatuses, nextState.filters.vocabStatus);
  nextState.discover = { ...defaults.discover, ...(nextState.discover || {}) };
  nextState.preferences = { ...defaults.preferences, ...(nextState.preferences || {}) };
  nextState.preferences.srsAlgorithm = nextState.preferences.srsAlgorithm === "fsrs" ? "fsrs" : "sm2";
  nextState.preferences.ankiExportStatuses = normalizeAnkiExportStatuses(nextState.preferences.ankiExportStatuses);
  nextState.preferences.lastReadTextIds = nextState.preferences.lastReadTextIds && typeof nextState.preferences.lastReadTextIds === "object" && !Array.isArray(nextState.preferences.lastReadTextIds)
    ? nextState.preferences.lastReadTextIds
    : {};
  nextState.readerFontSize = clamp(Number(nextState.readerFontSize) || 18, 14, 28);
  nextState.readerPage = Number(nextState.readerPage) || 1;
  nextState.readerPages = nextState.readerPages && typeof nextState.readerPages === "object" ? nextState.readerPages : {};
  nextState.readerScrolls = nextState.readerScrolls && typeof nextState.readerScrolls === "object" ? nextState.readerScrolls : {};
  nextState.readerSelectionRange = null;
  
  if (!nextState.preferences.learningLanguage) {
    nextState.preferences.learningLanguage = "de";
  }
  if (nextState.currentTextId && !nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage]) {
    nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage] = nextState.currentTextId;
  }
  if (nextState.preferences.lastReadTextId && !nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage]) {
    nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage] = nextState.preferences.lastReadTextId;
  }

  if (!nextState.profiles) {
    nextState.profiles = {
      "de": {
        vocab: nextState.vocab && typeof nextState.vocab === "object" ? nextState.vocab : {},
        customTexts: Array.isArray(nextState.customTexts) ? nextState.customTexts : [],
        userBooks: Array.isArray(nextState.userBooks) ? nextState.userBooks : [],
        hiddenBuiltInBooks: Array.isArray(nextState.hiddenBuiltInBooks) ? nextState.hiddenBuiltInBooks : [],
        archivedBookIds: Array.isArray(nextState.archivedBookIds) ? nextState.archivedBookIds : [],
        preferences: {
          dictionaryUrl: nextState.preferences?.dictionaryUrl || getDefaultDictionaryUrl("de")
        }
      }
    };
  }

  const lang = nextState.preferences.learningLanguage;
  if (!nextState.profiles[lang]) {
    nextState.profiles[lang] = {
      vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [],
      preferences: { dictionaryUrl: getDefaultDictionaryUrl(lang), dictionaryMode: "internal" }
    };
  }

  const active = nextState.profiles[lang];
  nextState.vocab = active.vocab || {};
  nextState.customTexts = active.customTexts || [];
  nextState.userBooks = active.userBooks || [];
  nextState.hiddenBuiltInBooks = active.hiddenBuiltInBooks || [];
  active.archivedBookIds = Array.isArray(active.archivedBookIds) ? active.archivedBookIds : [];
  nextState.archivedBookIds = active.archivedBookIds;
  nextState.preferences.dictionaryUrl = active.preferences?.dictionaryUrl || getDefaultDictionaryUrl(lang);

  for (const [pLang, profile] of Object.entries(nextState.profiles)) {
    if (["uk", "ru", "ja"].includes(pLang)) {
      if (profile.preferences && profile.preferences.dictionaryUrl && profile.preferences.dictionaryUrl.includes("diki.pl")) {
        profile.preferences.dictionaryUrl = getDefaultDictionaryUrl(pLang);
      }
    }
  }
  
  if (["uk", "ru", "ja"].includes(lang) && nextState.preferences.dictionaryUrl.includes("diki.pl")) {
    nextState.preferences.dictionaryUrl = getDefaultDictionaryUrl(lang);
  }

  for (const word of Object.keys(nextState.vocab)) {
    const e = nextState.vocab[word];
    if (!Number.isFinite(e.interval)) e.interval = 0;
    if (!Number.isFinite(e.repetition)) e.repetition = 0;
    if (!Number.isFinite(e.efactor)) e.efactor = 2.5;
    if (!Number.isFinite(e.stability)) e.stability = 0;
    if (!Number.isFinite(e.difficulty)) e.difficulty = 5;
    if (e.srsAlgorithm !== "fsrs") e.srsAlgorithm = "sm2";
    if (!e.nextDate) e.nextDate = new Date().toISOString().slice(0, 10);
  }
  return nextState;
}

function loadState() {
  const fallback = createDefaultState();
  if (window.__qtBridge && window.__bridgeState) {
    try {
      const snap = window.__bridgeState;
      const prefs = snap.prefs || {};
      const userBooks = prefs.__userBooks || [];
      delete prefs.__userBooks;
      const rawVocab = snap.vocab && typeof snap.vocab === "object" ? snap.vocab : {};
      const hasProfiles = Object.values(rawVocab).some(
        v => v && typeof v === "object" && v.vocab !== undefined
      );
      
      const merged = {
        ...fallback,
        customTexts: hasProfiles ? [] : (Array.isArray(snap.texts) ? snap.texts : []),
        userBooks: hasProfiles ? [] : (Array.isArray(userBooks) ? userBooks : []),
        hiddenBuiltInBooks: hasProfiles ? [] : (Array.isArray(snap.hiddenBooks) ? snap.hiddenBooks : []),
        vocab: hasProfiles ? {} : rawVocab,
        profiles: hasProfiles ? rawVocab : null,
        preferences: { ...fallback.preferences, ...prefs }
      };
      
      if (hasProfiles && Array.isArray(snap.texts)) {
        for (const k of Object.keys(merged.profiles)) {
          if (merged.profiles[k].customTexts) merged.profiles[k].customTexts = [];
        }
        for (const t of snap.texts) {
          const m = t.id.match(/^([a-z]{2})-/);
          const targetLang = t.lang || (m ? m[1] : "de");
          
          if (merged.profiles[targetLang]) {
            if (!merged.profiles[targetLang].customTexts) merged.profiles[targetLang].customTexts = [];
            merged.profiles[targetLang].customTexts.push(t);
          } else {
             if (!merged.profiles["de"]) merged.profiles["de"] = { vocab:{}, customTexts:[] };
             if (!merged.profiles["de"].customTexts) merged.profiles["de"].customTexts = [];
             merged.profiles["de"].customTexts.push(t);
          }
        }
      }
      return normalizeState(merged);
    } catch (error) {
      console.warn("Bridge state load failed, falling back to localStorage", error);
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return normalizeState({ ...fallback, ...JSON.parse(raw) });
  } catch (error) {
    console.warn("Failed to read localStorage", error);
    return fallback;
  }
}

// --- Proxy-based auto-save -------------------------------------------------

const _proxyCache = new WeakMap();
let _saveTimer = null;
let _suspendAutoSave = 0;

function _unwrapProxy(value) {
  if (value && typeof value === "object" && value._raw) return value._raw;
  return value;
}

function _toPlain(value, seen = new WeakSet()) {
  value = _unwrapProxy(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => _toPlain(item, seen));
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const plain = _toPlain(item, seen);
    if (plain !== undefined) result[key] = plain;
  }
  return result;
}

let _saveInFlight = false;
let _savePending = false;

function _doSave() {
  const rawState = state._raw || state;
  if (rawState.profiles && rawState.preferences) {
    const lang = rawState.preferences.learningLanguage;
    if (rawState.profiles[lang]) {
      rawState.profiles[lang].preferences = rawState.profiles[lang].preferences || {};
      rawState.profiles[lang].preferences.dictionaryUrl = rawState.preferences.dictionaryUrl;
    }
  }
  if (window.__qtBridge) {
    const payload = {
      texts: _toPlain(rawState.customTexts || []),
      prefs: {
        ..._toPlain(rawState.preferences || {}),
        __userBooks: _toPlain(rawState.userBooks || [])
      },
      hiddenBooks: _toPlain(rawState.hiddenBuiltInBooks || []),
      vocab: _toPlain(rawState.profiles || {})
    };
    const body = JSON.stringify(payload);
    _saveInFlight = true;
    _saveWithRetry(body, 3).then(() => {
      _saveInFlight = false;
      if (_savePending) {
        _savePending = false;
        _doSave();
      }
    }).catch((e) => {
      _saveInFlight = false;
      console.error("bridge save failed after retries", e);
      // Schedule one more attempt
      _savePending = false;
      _scheduleSave();
    });
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_toPlain(rawState)));
    } catch (e) {
      console.error("localStorage save failed", e);
    }
  }
}

async function _saveWithRetry(body, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("/__store/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WH-Token": window.WH_TOKEN || ""
        },
        body
      });
      if (response.ok) return;
      throw new Error(`HTTP ${response.status}`);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

function _scheduleSave() {
  if (_suspendAutoSave > 0) return;
  if (_saveInFlight) {
    _savePending = true;
    return;
  }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 200);
}

function _createDeepProxy(target, path = []) {
  if (_proxyCache.has(target)) return _proxyCache.get(target);

  const handler = {
    get(t, prop, receiver) {
      if (prop === "_raw") return t;
      const value = Reflect.get(t, prop, receiver);
      if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        const cached = _proxyCache.get(value);
        if (cached) return cached;
        const proxy = _createDeepProxy(value, [...path, prop]);
        _proxyCache.set(value, proxy);
        return proxy;
      }
      return value;
    },
    set(t, prop, value, receiver) {
      const old = t[prop];
      const rawValue = _unwrapProxy(value);
      const result = Reflect.set(t, prop, rawValue, t);
      if (old !== rawValue) _scheduleSave();
      return result;
    },
    deleteProperty(t, prop) {
      if (prop in t) {
        Reflect.deleteProperty(t, prop);
        _scheduleSave();
      }
      return true;
    }
  };

  const proxy = new Proxy(target, handler);
  _proxyCache.set(target, proxy);
  return proxy;
}

// Load raw state, then wrap in a deep proxy.
const _rawState = loadState();
export const state = _createDeepProxy(_rawState);

export const initialVocabKeys = new Set(Object.keys(state.vocab || {}));

export function resetInitialVocabKeys() {
  initialVocabKeys.clear();
  Object.keys(state.vocab || {}).forEach((key) => initialVocabKeys.add(key));
}

export function flushPendingSave() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  // Use synchronous XHR for closeEvent — guarantees data is sent before window closes
  const rawState = state._raw || state;
  if (rawState.profiles && rawState.preferences) {
    const lang = rawState.preferences.learningLanguage;
    if (rawState.profiles[lang]) {
      rawState.profiles[lang].preferences = rawState.profiles[lang].preferences || {};
      rawState.profiles[lang].preferences.dictionaryUrl = rawState.preferences.dictionaryUrl;
    }
  }
  if (window.__qtBridge) {
    try {
      const payload = {
        texts: _toPlain(rawState.customTexts || []),
        prefs: {
          ..._toPlain(rawState.preferences || {}),
          __userBooks: _toPlain(rawState.userBooks || [])
        },
        hiddenBooks: _toPlain(rawState.hiddenBuiltInBooks || []),
        vocab: _toPlain(rawState.profiles || {})
      };
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/__store/save", false); // synchronous!
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("X-WH-Token", window.WH_TOKEN || "");
      xhr.send(JSON.stringify(payload));
    } catch (e) {
      console.error("flush save failed", e);
    }
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_toPlain(rawState)));
    } catch (e) {
      console.error("flush localStorage save failed", e);
    }
  }
}
window.flushPendingSave = flushPendingSave;

export function saveState() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  if (_saveInFlight) {
    _savePending = true;
    return;
  }
  _doSave();
}

export function getLastReadTextId(lang = state.preferences?.learningLanguage) {
  if (!lang) return null;
  const map = state.preferences?.lastReadTextIds;
  return map && typeof map === "object" ? map[lang] || null : null;
}

export function setLastReadTextId(id, lang = state.preferences?.learningLanguage) {
  if (!id || !lang) return;
  if (!state.preferences.lastReadTextIds || typeof state.preferences.lastReadTextIds !== "object") {
    state.preferences.lastReadTextIds = {};
  }
  state.preferences.lastReadTextIds[lang] = id;
}

export function clearLastReadTextId(id, lang = state.preferences?.learningLanguage) {
  if (!id || !lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object" && map[lang] === id) {
    delete map[lang];
  }
}

export function clearLastReadTextForLanguage(lang = state.preferences?.learningLanguage) {
  if (!lang) return;
  const map = state.preferences?.lastReadTextIds;
  if (map && typeof map === "object") {
    delete map[lang];
  }
}

export function replaceState(nextState) {
  _suspendAutoSave++;
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, nextState);
  _suspendAutoSave--;
  resetInitialVocabKeys();
  saveState();
}

export function switchLearningLanguage(lang) {
  flushPendingSave();
  state.preferences.learningLanguage = lang;
  
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
