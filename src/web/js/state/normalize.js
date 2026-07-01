import { LEARNING_LANGUAGES, STORAGE_KEY, UI_SCALE } from "../constants.js";
import { clamp, cleanCatalogTitle } from "../utils.js";
import { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./defaults.js";
import { normalizeLearningColors } from "../reader-colors.js";

function cleanSavedCatalogTitles(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item && typeof item.title === "string") item.title = cleanCatalogTitle(item.title);
  }
}

export function normalizeState(nextState) {
  const defaults = createDefaultState();
  nextState.customTexts = Array.isArray(nextState.customTexts) ? nextState.customTexts : [];
  nextState.userBooks = Array.isArray(nextState.userBooks) ? nextState.userBooks : [];
  cleanSavedCatalogTitles(nextState.userBooks);
  nextState.hiddenBuiltInBooks = Array.isArray(nextState.hiddenBuiltInBooks) ? nextState.hiddenBuiltInBooks : [];
  nextState.archivedBookIds = Array.isArray(nextState.archivedBookIds) ? nextState.archivedBookIds : [];
  nextState.vocab = nextState.vocab && typeof nextState.vocab === "object" ? nextState.vocab : {};
  nextState.dataDirectory = typeof nextState.dataDirectory === "string" ? nextState.dataDirectory : "";
  nextState.syncDirectory = typeof nextState.syncDirectory === "string" ? nextState.syncDirectory : "";
  nextState.filters = { ...defaults.filters, ...(nextState.filters || {}) };
  nextState.filters.vocabStatuses = normalizeVocabStatusFilters(nextState.filters.vocabStatuses, nextState.filters.vocabStatus);
  nextState.discover = { ...defaults.discover, ...(nextState.discover || {}) };
  nextState.preferences = { ...defaults.preferences, ...(nextState.preferences || {}) };
  if (!["offline", "deepl", "google", "lmstudio"].includes(nextState.preferences.translationProvider)) nextState.preferences.translationProvider = "google";
  nextState.preferences.languageOnboardingDone = nextState.preferences.languageOnboardingDone === true;
  nextState.preferences.srsAlgorithm = nextState.preferences.srsAlgorithm === "sm2" ? "sm2" : "fsrs";
  nextState.preferences.ankiExportStatuses = normalizeAnkiExportStatuses(nextState.preferences.ankiExportStatuses);
  nextState.preferences.readerFocusMode = nextState.preferences.readerFocusMode === true;
  nextState.preferences.readerWordPanelVisible = nextState.preferences.readerWordPanelVisible !== false;
  nextState.preferences.touchControls = nextState.preferences.touchControls === true;
  nextState.preferences.inTextReview = nextState.preferences.inTextReview === true;
  nextState.preferences.ttsWordHighlight = nextState.preferences.ttsWordHighlight === true;
  nextState.preferences.dynamicLearningColors = nextState.preferences.dynamicLearningColors === true;
  nextState.preferences.learningColors = normalizeLearningColors(nextState.preferences.learningColors);
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

  const legacyLang = nextState.preferences.learningLanguage || "de";
  if (!nextState.profiles) {
    nextState.profiles = {
      [legacyLang]: {
        vocab: nextState.vocab,
        customTexts: nextState.customTexts,
        userBooks: nextState.userBooks,
        hiddenBuiltInBooks: nextState.hiddenBuiltInBooks,
        archivedBookIds: nextState.archivedBookIds,
        preferences: { dictionaryUrl: nextState.preferences.dictionaryUrl || getDefaultDictionaryUrl(legacyLang) }
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
  cleanSavedCatalogTitles(nextState.userBooks);
  nextState.hiddenBuiltInBooks = active.hiddenBuiltInBooks || [];
  active.archivedBookIds = Array.isArray(active.archivedBookIds) ? active.archivedBookIds : [];
  nextState.archivedBookIds = active.archivedBookIds;
  nextState.preferences.dictionaryUrl = active.preferences?.dictionaryUrl || getDefaultDictionaryUrl(lang);

  const nonDikiLanguages = ["uk", "ru", "ja", "zh", "la", "grc"];
  for (const [profileLang, profile] of Object.entries(nextState.profiles)) {
    if (nonDikiLanguages.includes(profileLang) && profile.preferences?.dictionaryUrl?.includes("diki.pl")) {
      profile.preferences.dictionaryUrl = getDefaultDictionaryUrl(profileLang);
    }
  }
  if (nonDikiLanguages.includes(lang) && nextState.preferences.dictionaryUrl.includes("diki.pl")) {
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
  if ((window.__qtBridge || window.WordHunterAndroid) && window.__bridgeState) {
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
        syncDirectory: typeof snap.syncDir === "string" ? snap.syncDir : "",
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
          const match = text.id.match(/^([a-z]{2,3})-/);
          const prefixLang = match && LEARNING_LANGUAGES.includes(match[1]) ? match[1] : "";
          const targetLang = text.lang || prefixLang || merged.preferences.learningLanguage || "de";
          const profile = merged.profiles[targetLang] || (merged.profiles[targetLang] ||= { vocab: {}, customTexts: [] });
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
