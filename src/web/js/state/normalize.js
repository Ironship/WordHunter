// @ts-check

import { LEARNING_LANGUAGES, STATE_SCHEMA_VERSION, STATUS_ORDER, STORAGE_KEY, UI_SCALE } from "../constants.js";
import { clamp, cleanCatalogTitle } from "../utils.js";
import { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./defaults.js";
import { normalizeLearningColors } from "../reader-colors.js";
import { normalizeTheme } from "../theme.js";
import { normalizeTranslationLanguageCode } from "../translator-preferences.js";

function cleanSavedCatalogTitles(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item && typeof item.title === "string") item.title = cleanCatalogTitle(item.title);
  }
}

/**
 * @param {unknown} value
 * @returns {value is WhRecord}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectEntries(value) {
  return isRecord(value) ? Object.entries(value) : [];
}

function objectArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export class UnsupportedStateSchemaError extends Error {
  constructor(source, version) {
    super(`${source} schema version ${version || "missing"} is not supported`);
    this.name = "UnsupportedStateSchemaError";
  }
}

/**
 * @param {unknown} value
 * @param {string} [source]
 * @returns {asserts value is WhBridgeSnapshot}
 */
export function assertSupportedStateSchemaVersion(value, source = "state payload") {
  if (!isRecord(value)) throw new UnsupportedStateSchemaError(source, "missing");
  const version = Number(value.schemaVersion);
  if (version !== STATE_SCHEMA_VERSION) {
    throw new UnsupportedStateSchemaError(source, value.schemaVersion);
  }
}

function normalizeSyncConflicts(value) {
  return objectArray(value).map((conflict) => ({
    id: typeof conflict.id === "string" ? conflict.id : "",
    key: typeof conflict.key === "string" ? conflict.key : "",
    reason: typeof conflict.reason === "string" ? conflict.reason : "",
    timestamp: typeof conflict.timestamp === "string" ? conflict.timestamp : "",
    kept: isRecord(conflict.kept) ? conflict.kept : {},
    conflict: isRecord(conflict.conflict) ? conflict.conflict : {}
  })).filter((conflict) => conflict.id);
}

function normalizeRecoveryItems(value) {
  return objectArray(value).map((item) => ({
    path: typeof item.path === "string" ? item.path : "",
    kind: typeof item.kind === "string" ? item.kind : "",
    error: typeof item.error === "string" ? item.error : ""
  })).filter((item) => item.path || item.error);
}

function normalizeRecoveryStatus(value) {
  if (!isRecord(value)) return null;
  return {
    schemaVersion: Math.max(0, Math.trunc(Number(value.schemaVersion) || 0)),
    skippedRecordCount: Math.max(0, Math.trunc(Number(value.skippedRecordCount) || 0)),
    skippedRecords: normalizeRecoveryItems(value.skippedRecords),
    corruptConflictCount: Math.max(0, Math.trunc(Number(value.corruptConflictCount) || 0)),
    corruptConflicts: normalizeRecoveryItems(value.corruptConflicts),
    pendingSaveJournal: value.pendingSaveJournal === true,
    pendingSaveJournalTemp: value.pendingSaveJournalTemp === true,
    pendingWipeJournal: value.pendingWipeJournal === true,
    quarantinedSaveJournal: value.quarantinedSaveJournal === true
  };
}

function normalizeVocabEntries(rawVocab) {
  const vocab = {};
  for (const [word, entry] of objectEntries(rawVocab)) {
    if (!isRecord(entry)) continue;
    if (!STATUS_ORDER.includes(entry.status)) entry.status = "new";
    if (!Number.isFinite(entry.interval)) entry.interval = 0;
    if (!Number.isFinite(entry.repetition)) entry.repetition = 0;
    if (!Number.isFinite(entry.efactor)) entry.efactor = 2.5;
    if (!Number.isFinite(entry.stability)) entry.stability = 0;
    if (!Number.isFinite(entry.difficulty)) entry.difficulty = 5;
    if (entry.srsAlgorithm !== "fsrs") entry.srsAlgorithm = "sm2";
    if (!entry.nextDate) entry.nextDate = new Date().toISOString().slice(0, 10);
    vocab[word] = entry;
  }
  return vocab;
}

function createEmptyProfile(lang) {
  return {
    vocab: {},
    customTexts: [],
    userBooks: [],
    hiddenBuiltInBooks: [],
    archivedBookIds: [],
    preferences: { dictionaryUrl: getDefaultDictionaryUrl(lang), dictionaryMode: "internal" }
  };
}

function normalizeProfile(rawProfile, lang) {
  const profile = isRecord(rawProfile) ? rawProfile : createEmptyProfile(lang);
  profile.vocab = normalizeVocabEntries(profile.vocab);
  profile.customTexts = objectArray(profile.customTexts)
    .filter((text) => text.id !== "gutenberg-full-undefined");
  profile.userBooks = objectArray(profile.userBooks);
  cleanSavedCatalogTitles(profile.userBooks);
  profile.hiddenBuiltInBooks = stringArray(profile.hiddenBuiltInBooks);
  profile.archivedBookIds = stringArray(profile.archivedBookIds);
  profile.preferences = isRecord(profile.preferences) ? profile.preferences : {};
  delete profile.preferences.theme;
  delete profile.preferences.darkMode;
  profile.preferences.translationSourceLanguage = normalizeTranslationLanguageCode(profile.preferences.translationSourceLanguage);
  profile.preferences.translationTargetLanguage = normalizeTranslationLanguageCode(profile.preferences.translationTargetLanguage);
  return profile;
}

function normalizeProfiles(rawProfiles) {
  return Object.fromEntries(
    objectEntries(rawProfiles)
      .filter(([lang]) => lang)
      .map(([lang, profile]) => [lang, normalizeProfile(profile, lang)])
  );
}

export function normalizeState(nextState) {
  const defaults = createDefaultState();
  nextState.schemaVersion = STATE_SCHEMA_VERSION;
  nextState.customTexts = objectArray(nextState.customTexts);
  nextState.userBooks = objectArray(nextState.userBooks);
  cleanSavedCatalogTitles(nextState.userBooks);
  nextState.hiddenBuiltInBooks = stringArray(nextState.hiddenBuiltInBooks);
  nextState.archivedBookIds = stringArray(nextState.archivedBookIds);
  nextState.vocab = normalizeVocabEntries(nextState.vocab);
  nextState.dataDirectory = typeof nextState.dataDirectory === "string" ? nextState.dataDirectory : "";
  nextState.syncDirectory = typeof nextState.syncDirectory === "string" ? nextState.syncDirectory : "";
  nextState.syncHealth = isRecord(nextState.syncHealth) ? nextState.syncHealth : null;
  nextState.cloudSyncStatus = isRecord(nextState.cloudSyncStatus) ? nextState.cloudSyncStatus : null;
  nextState.syncthingStatus = isRecord(nextState.syncthingStatus) ? nextState.syncthingStatus : null;
  nextState.syncConflictCount = Math.max(0, Math.trunc(Number(nextState.syncConflictCount) || 0));
  nextState.syncConflicts = normalizeSyncConflicts(nextState.syncConflicts);
  nextState.recoveryStatus = normalizeRecoveryStatus(nextState.recoveryStatus);
  const rawFilters = isRecord(nextState.filters) ? nextState.filters : {};
  nextState.filters = { ...defaults.filters, ...rawFilters };
  nextState.filters.vocabStatuses = normalizeVocabStatusFilters(nextState.filters.vocabStatuses);
  for (const key of Object.keys(nextState.filters)) {
    if (!Object.hasOwn(defaults.filters, key)) delete nextState.filters[key];
  }
  nextState.discover = { ...defaults.discover, ...(nextState.discover || {}) };
  for (const key of Object.keys(nextState.discover)) {
    if (!Object.hasOwn(defaults.discover, key)) delete nextState.discover[key];
  }
  const rawPreferences = isRecord(nextState.preferences) ? nextState.preferences : {};
  nextState.preferences = { ...defaults.preferences, ...rawPreferences };
  nextState.preferences.theme = normalizeTheme(rawPreferences.theme, rawPreferences.darkMode);
  delete nextState.preferences.darkMode;
  if (!["offline", "deepl", "google", "lmstudio"].includes(nextState.preferences.translationProvider)) nextState.preferences.translationProvider = "google";
  nextState.preferences.languageOnboardingDone = nextState.preferences.languageOnboardingDone === true;
  nextState.preferences.srsAlgorithm = nextState.preferences.srsAlgorithm === "sm2" ? "sm2" : "fsrs";
  if (!["percentages", "counts", "both"].includes(nextState.preferences.cardStatsMode)) nextState.preferences.cardStatsMode = "percentages";
  nextState.preferences.ankiExportStatuses = normalizeAnkiExportStatuses(nextState.preferences.ankiExportStatuses);
  nextState.preferences.readerFocusMode = nextState.preferences.readerFocusMode === true;
  nextState.preferences.readerWordPanelVisible = nextState.preferences.readerWordPanelVisible !== false;
  nextState.preferences.touchControls = nextState.preferences.touchControls === true;
  nextState.preferences.inTextReview = nextState.preferences.inTextReview === true;
  nextState.preferences.ttsWordHighlight = rawPreferences.ttsWordHighlightDefaultVersion === 1
    && typeof rawPreferences.ttsWordHighlight === "boolean"
    ? rawPreferences.ttsWordHighlight
    : true;
  nextState.preferences.ttsWordHighlightDefaultVersion = 1;
  nextState.preferences.statusSoundsEnabled = nextState.preferences.statusSoundsEnabled !== false;
  nextState.preferences.statusSoundVolume = clamp(Number(nextState.preferences.statusSoundVolume) || 0, 0, 1);
  nextState.preferences.dynamicLearningColors = nextState.preferences.dynamicLearningColors === true;
  nextState.preferences.learningColors = normalizeLearningColors(nextState.preferences.learningColors);
  nextState.preferences.lastReadTextIds = nextState.preferences.lastReadTextIds && typeof nextState.preferences.lastReadTextIds === "object" && !Array.isArray(nextState.preferences.lastReadTextIds)
    ? nextState.preferences.lastReadTextIds : {};
  nextState.readerFontSize = clamp(Number(rawPreferences.readerFontSize ?? nextState.readerFontSize) || 18, 14, 28);
  nextState.preferences.readerFontSize = nextState.readerFontSize;
  nextState.readerPdfZoom = clamp(Number(nextState.readerPdfZoom) || 1, 0.75, 3);
  nextState.readerPdfViewMode = nextState.readerPdfViewMode === "text" ? "text" : "overlay";
  nextState.preferences.uiScale = clamp(Math.round(Number(nextState.preferences.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
  nextState.readerPage = Number(nextState.readerPage) || 1;
  nextState.readerPages = nextState.readerPages && typeof nextState.readerPages === "object" ? nextState.readerPages : {};
  nextState.readerScrolls = nextState.readerScrolls && typeof nextState.readerScrolls === "object" ? nextState.readerScrolls : {};
  nextState.readerScrollsPerPage = nextState.readerScrollsPerPage && typeof nextState.readerScrollsPerPage === "object" && !Array.isArray(nextState.readerScrollsPerPage)
    ? nextState.readerScrollsPerPage : {};
  nextState.readerSelectionRange = null;
  nextState.selectedWordIndex = Number.isInteger(nextState.selectedWordIndex) && nextState.selectedWordIndex >= 0
    ? nextState.selectedWordIndex
    : null;

  if (!nextState.preferences.learningLanguage) nextState.preferences.learningLanguage = "de";

  if (!isRecord(nextState.profiles)) {
    nextState.profiles = defaults.profiles;
  }
  nextState.profiles = normalizeProfiles(nextState.profiles);
  const lang = nextState.preferences.learningLanguage;
  if (!nextState.profiles[lang]) {
    nextState.profiles[lang] = createEmptyProfile(lang);
  }

  const active = nextState.profiles[lang];
  nextState.vocab = active.vocab;
  nextState.customTexts = active.customTexts;
  nextState.userBooks = active.userBooks;
  cleanSavedCatalogTitles(nextState.userBooks);
  nextState.hiddenBuiltInBooks = active.hiddenBuiltInBooks;
  nextState.archivedBookIds = active.archivedBookIds;
  nextState.preferences.dictionaryUrl = active.preferences?.dictionaryUrl || getDefaultDictionaryUrl(lang);
  nextState.preferences.translationSourceLanguage = active.preferences?.translationSourceLanguage || "";
  nextState.preferences.translationTargetLanguage = active.preferences?.translationTargetLanguage
    || (lang === "other" ? normalizeTranslationLanguageCode(nextState.preferences.locale) || "en" : "");
  if (lang === "other") {
    active.preferences.translationSourceLanguage = nextState.preferences.translationSourceLanguage;
    active.preferences.translationTargetLanguage = nextState.preferences.translationTargetLanguage;
  }

  const nonDikiLanguages = ["uk", "ru", "ja", "zh", "la", "grc"];
  for (const [profileLang, profile] of Object.entries(nextState.profiles)) {
    if (nonDikiLanguages.includes(profileLang) && profile.preferences?.dictionaryUrl?.includes("diki.pl")) {
      profile.preferences.dictionaryUrl = getDefaultDictionaryUrl(profileLang);
    }
  }
  if (nonDikiLanguages.includes(lang) && nextState.preferences.dictionaryUrl.includes("diki.pl")) {
    nextState.preferences.dictionaryUrl = getDefaultDictionaryUrl(lang);
  }

  return nextState;
}

export function loadState() {
  const fallback = createDefaultState();
  if ((window.__qtBridge || window.WordHunterAndroid) && window.__bridgeState) {
    try {
      const snap = window.__bridgeState;
      assertSupportedStateSchemaVersion(snap, "bridge snapshot");
      const prefs = isRecord(snap.prefs) ? { ...snap.prefs } : {};
      const discover = isRecord(prefs.__discover) ? prefs.__discover : fallback.discover;
      delete prefs.__discover;
      const rawVocab = isRecord(snap.vocab) ? snap.vocab : {};
      const merged = {
        ...fallback,
        schemaVersion: snap.schemaVersion || fallback.schemaVersion,
        dataDirectory: typeof snap.dataDir === "string" ? snap.dataDir : "",
        syncDirectory: typeof snap.syncDir === "string" ? snap.syncDir : "",
        syncHealth: isRecord(snap.syncHealth) ? snap.syncHealth : null,
        cloudSyncStatus: isRecord(snap.cloudSyncStatus) ? snap.cloudSyncStatus : null,
        syncthingStatus: isRecord(snap.syncthingStatus) ? snap.syncthingStatus : null,
        syncConflictCount: snap.syncConflictCount,
        syncConflicts: snap.syncConflicts,
        recoveryStatus: snap.recoveryStatus,
        customTexts: [],
        userBooks: [],
        hiddenBuiltInBooks: stringArray(snap.hiddenBooks),
        vocab: {},
        profiles: rawVocab,
        discover,
        preferences: prefs
      };
      if (Array.isArray(snap.texts)) {
        for (const [profileLang, rawProfile] of objectEntries(merged.profiles)) {
          const profile = isRecord(rawProfile)
            ? rawProfile
            : (merged.profiles[profileLang] = createEmptyProfile(profileLang));
          profile.customTexts = [];
        }
        for (const text of objectArray(snap.texts)) {
          const textId = typeof text.id === "string" ? text.id : "";
          if (!textId) continue;
          const prefixLang = LEARNING_LANGUAGES.find((code) => textId.startsWith(`${code}-`)) || "";
          const targetLang = text.lang || prefixLang || merged.preferences.learningLanguage || "de";
          const profile = isRecord(merged.profiles[targetLang])
            ? merged.profiles[targetLang]
            : (merged.profiles[targetLang] = createEmptyProfile(targetLang));
          if (!Array.isArray(profile.customTexts)) profile.customTexts = [];
          profile.customTexts.push(text);
        }
      }
      return normalizeState(merged);
    } catch (error) {
      console.warn("Bridge state load failed", error);
      throw error;
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    assertSupportedStateSchemaVersion(parsed, "localStorage cache");
    return normalizeState({ ...fallback, ...parsed });
  } catch (error) {
    console.warn("Failed to read localStorage", error);
    return fallback;
  }
}
