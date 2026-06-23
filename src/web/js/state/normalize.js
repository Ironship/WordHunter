import { STORAGE_KEY, UI_SCALE } from "../constants.js";
import { clamp } from "../utils.js";
import { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./defaults.js";

export function normalizeState(nextState) {
  const defaults = createDefaultState();
  nextState.customTexts = Array.isArray(nextState.customTexts) ? nextState.customTexts : [];
  nextState.userBooks = Array.isArray(nextState.userBooks) ? nextState.userBooks : [];
  nextState.hiddenBuiltInBooks = Array.isArray(nextState.hiddenBuiltInBooks) ? nextState.hiddenBuiltInBooks : [];
  nextState.archivedBookIds = Array.isArray(nextState.archivedBookIds) ? nextState.archivedBookIds : [];
  nextState.vocab = nextState.vocab && typeof nextState.vocab === "object" ? nextState.vocab : {};
  nextState.dataDirectory = typeof nextState.dataDirectory === "string" ? nextState.dataDirectory : "";
  nextState.filters = { ...defaults.filters, ...(nextState.filters || {}) };
  nextState.filters.vocabStatuses = normalizeVocabStatusFilters(nextState.filters.vocabStatuses, nextState.filters.vocabStatus);
  nextState.discover = { ...defaults.discover, ...(nextState.discover || {}) };
  nextState.preferences = { ...defaults.preferences, ...(nextState.preferences || {}) };
  if (!["offline", "deepl", "google", "lmstudio"].includes(nextState.preferences.translationProvider)) nextState.preferences.translationProvider = "google";
  nextState.preferences.srsAlgorithm = nextState.preferences.srsAlgorithm === "sm2" ? "sm2" : "fsrs";
  nextState.preferences.ankiExportStatuses = normalizeAnkiExportStatuses(nextState.preferences.ankiExportStatuses);
  nextState.preferences.lastReadTextIds = nextState.preferences.lastReadTextIds && typeof nextState.preferences.lastReadTextIds === "object" && !Array.isArray(nextState.preferences.lastReadTextIds)
    ? nextState.preferences.lastReadTextIds : {};
  nextState.readerFontSize = clamp(Number(nextState.readerFontSize) || 18, 14, 28);
  nextState.preferences.uiScale = clamp(Math.round(Number(nextState.preferences.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
  nextState.readerPage = Number(nextState.readerPage) || 1;
  nextState.readerPages = nextState.readerPages && typeof nextState.readerPages === "object" ? nextState.readerPages : {};
  nextState.readerScrolls = nextState.readerScrolls && typeof nextState.readerScrolls === "object" ? nextState.readerScrolls : {};
  nextState.readerScrollsPerPage = nextState.readerScrollsPerPage && typeof nextState.readerScrollsPerPage === "object" && !Array.isArray(nextState.readerScrollsPerPage)
    ? nextState.readerScrollsPerPage : {};
  nextState.readerSelectionRange = null;

  if (!nextState.preferences.learningLanguage) nextState.preferences.learningLanguage = "de";
  if (nextState.currentTextId && !nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage]) {
    nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage] = nextState.currentTextId;
  }
  // ponytail: singular key is a migration path for existing installations.
  if (nextState.preferences.lastReadTextId && !nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage]) {
    nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage] = nextState.preferences.lastReadTextId;
  }

  if (!nextState.profiles) {
    nextState.profiles = {
      de: {
        vocab: nextState.vocab,
        customTexts: nextState.customTexts,
        userBooks: nextState.userBooks,
        hiddenBuiltInBooks: nextState.hiddenBuiltInBooks,
        archivedBookIds: nextState.archivedBookIds,
        preferences: { dictionaryUrl: nextState.preferences.dictionaryUrl || getDefaultDictionaryUrl("de") }
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

  for (const [profileLang, profile] of Object.entries(nextState.profiles)) {
    if (["uk", "ru", "ja"].includes(profileLang) && profile.preferences?.dictionaryUrl?.includes("diki.pl")) {
      profile.preferences.dictionaryUrl = getDefaultDictionaryUrl(profileLang);
    }
  }
  if (["uk", "ru", "ja"].includes(lang) && nextState.preferences.dictionaryUrl.includes("diki.pl")) {
    nextState.preferences.dictionaryUrl = getDefaultDictionaryUrl(lang);
  }

  for (const entry of Object.values(nextState.vocab)) {
    if (!Number.isFinite(entry.interval)) entry.interval = 0;
    if (!Number.isFinite(entry.repetition)) entry.repetition = 0;
    if (!Number.isFinite(entry.efactor)) entry.efactor = 2.5;
    if (!Number.isFinite(entry.stability)) entry.stability = 0;
    if (!Number.isFinite(entry.difficulty)) entry.difficulty = 5;
    if (entry.srsAlgorithm !== "fsrs") entry.srsAlgorithm = "sm2";
    if (!entry.nextDate) entry.nextDate = new Date().toISOString().slice(0, 10);
  }
  return nextState;
}

export function loadState() {
  const fallback = createDefaultState();
  if (window.__qtBridge && window.__bridgeState) {
    try {
      const snap = window.__bridgeState;
      const prefs = snap.prefs || {};
      const userBooks = prefs.__userBooks || [];
      delete prefs.__userBooks;
      const rawVocab = snap.vocab && typeof snap.vocab === "object" ? snap.vocab : {};
      const hasProfiles = Object.values(rawVocab).some((value) => value && typeof value === "object" && value.vocab !== undefined);
      const merged = {
        ...fallback,
        dataDirectory: typeof snap.dataDir === "string" ? snap.dataDir : "",
        customTexts: hasProfiles ? [] : (Array.isArray(snap.texts) ? snap.texts : []),
        userBooks: hasProfiles ? [] : (Array.isArray(userBooks) ? userBooks : []),
        hiddenBuiltInBooks: hasProfiles ? [] : (Array.isArray(snap.hiddenBooks) ? snap.hiddenBooks : []),
        vocab: hasProfiles ? {} : rawVocab,
        profiles: hasProfiles ? rawVocab : null,
        preferences: { ...fallback.preferences, ...prefs }
      };
      if (hasProfiles && Array.isArray(snap.texts)) {
        for (const profile of Object.values(merged.profiles)) {
          if (profile.customTexts) profile.customTexts = [];
        }
        for (const text of snap.texts) {
          const match = text.id.match(/^([a-z]{2})-/);
          const targetLang = text.lang || (match ? match[1] : "de");
          const profile = merged.profiles[targetLang] || (merged.profiles.de ||= { vocab: {}, customTexts: [] });
          if (!profile.customTexts) profile.customTexts = [];
          profile.customTexts.push(text);
        }
      }
      return normalizeState(merged);
    } catch (error) {
      console.warn("Bridge state load failed, falling back to localStorage", error);
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState({ ...fallback, ...JSON.parse(raw) }) : fallback;
  } catch (error) {
    console.warn("Failed to read localStorage", error);
    return fallback;
  }
}
