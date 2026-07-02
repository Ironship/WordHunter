import { LEARNING_LANGUAGES, STATE_SCHEMA_VERSION, STATUS_ORDER, STORAGE_KEY, UI_SCALE } from "../constants.js";
import { clamp, cleanCatalogTitle } from "../utils.js";
import { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./defaults.js";
import { normalizeLearningColors } from "../reader-colors.js";

function cleanSavedCatalogTitles(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item && typeof item.title === "string") item.title = cleanCatalogTitle(item.title);
  }
}

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
  profile.customTexts = objectArray(profile.customTexts);
  profile.userBooks = objectArray(profile.userBooks);
  cleanSavedCatalogTitles(profile.userBooks);
  profile.hiddenBuiltInBooks = stringArray(profile.hiddenBuiltInBooks);
  profile.archivedBookIds = stringArray(profile.archivedBookIds);
  profile.preferences = isRecord(profile.preferences) ? profile.preferences : {};
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
  nextState.syncConflictCount = Math.max(0, Math.trunc(Number(nextState.syncConflictCount) || 0));
  nextState.syncConflicts = normalizeSyncConflicts(nextState.syncConflicts);
  nextState.recoveryStatus = normalizeRecoveryStatus(nextState.recoveryStatus);
  nextState.migrationStatus = isRecord(nextState.migrationStatus) ? nextState.migrationStatus : null;
  const rawFilters = isRecord(nextState.filters) ? nextState.filters : {};
  const hasVocabStatuses = Object.hasOwn(rawFilters, "vocabStatuses");
  nextState.filters = { ...defaults.filters, ...rawFilters };
  nextState.filters.vocabStatuses = normalizeVocabStatusFilters(
    hasVocabStatuses ? nextState.filters.vocabStatuses : undefined,
    nextState.filters.vocabStatus
  );
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
  nextState.readerPdfZoom = clamp(Number(nextState.readerPdfZoom) || 1, 0.75, 3);
  nextState.readerPdfViewMode = nextState.readerPdfViewMode === "text" ? "text" : "overlay";
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
  // Singular key is a migration path for existing installations.
  if (nextState.preferences.lastReadTextId && !nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage]) {
    nextState.preferences.lastReadTextIds[nextState.preferences.learningLanguage] = nextState.preferences.lastReadTextId;
  }

  const legacyLang = nextState.preferences.learningLanguage || "de";
  if (!isRecord(nextState.profiles)) {
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
      const prefs = isRecord(snap.prefs) ? { ...snap.prefs } : {};
      const userBooks = prefs.__userBooks || [];
      delete prefs.__userBooks;
      const rawVocab = isRecord(snap.vocab) ? snap.vocab : {};
      const hasProfiles = snap.schemaVersion === STATE_SCHEMA_VERSION
        || Object.values(rawVocab).some((value) => isRecord(value) && value.vocab !== undefined);
      const merged = {
        ...fallback,
        schemaVersion: snap.schemaVersion || fallback.schemaVersion,
        dataDirectory: typeof snap.dataDir === "string" ? snap.dataDir : "",
        syncDirectory: typeof snap.syncDir === "string" ? snap.syncDir : "",
        syncConflictCount: snap.syncConflictCount,
        syncConflicts: snap.syncConflicts,
        recoveryStatus: snap.recoveryStatus,
        migrationStatus: isRecord(snap.migrationStatus) ? snap.migrationStatus : null,
        customTexts: hasProfiles ? [] : objectArray(snap.texts),
        userBooks: hasProfiles ? [] : objectArray(userBooks),
        hiddenBuiltInBooks: hasProfiles ? [] : stringArray(snap.hiddenBooks),
        vocab: hasProfiles ? {} : rawVocab,
        profiles: hasProfiles ? rawVocab : null,
        preferences: { ...fallback.preferences, ...prefs }
      };
      if (hasProfiles) {
        merged.profiles = normalizeProfiles(merged.profiles);
      }
      if (hasProfiles && Array.isArray(snap.texts)) {
        for (const profile of Object.values(merged.profiles)) {
          profile.customTexts = [];
        }
        for (const text of objectArray(snap.texts)) {
          const textId = typeof text.id === "string" ? text.id : "";
          if (!textId) continue;
          const match = textId.match(/^([a-z]{2,3})-/);
          const prefixLang = match && LEARNING_LANGUAGES.includes(match[1]) ? match[1] : "";
          const targetLang = text.lang || prefixLang || merged.preferences.learningLanguage || "de";
          const profile = merged.profiles[targetLang] || (merged.profiles[targetLang] = createEmptyProfile(targetLang));
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
