// @ts-check

import {
  DEFAULT_SELECTED_WORD_PANEL_ITEMS,
  LEARNING_LANGUAGES,
  SELECTED_WORD_PANEL_ITEM_IDS,
  STATE_SCHEMA_VERSION,
  STATUS_ORDER,
  STORAGE_KEY,
  UI_SCALE
} from "../constants.js";
import { clamp, cleanCatalogTitle } from "../utils.js";
import { createDefaultState, getDefaultDictionaryUrl, normalizeAnkiExportStatuses, normalizeVocabStatusFilters } from "./defaults.js";
import { normalizeLearningColors } from "../reader-colors.js";
import { normalizeTheme } from "../theme.js";
import { normalizeTranslationLanguageCode } from "../translator-preferences.js";
import { captureUiState, loadUiStateCache } from "./ui-cache.js";

type UnknownRecord = Record<string, unknown>;

function cleanSavedCatalogTitles(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const item of items as unknown[]) {
    if (isRecord(item) && typeof item.title === "string") item.title = cleanCatalogTitle(item.title);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVocabStatus(value: unknown): value is WhVocabStatus {
  return typeof value === "string" && STATUS_ORDER.includes(value as WhVocabStatus);
}

export function normalizeSelectedWordPanelItems(value: unknown): WhSelectedWordPanelItem[] {
  const defaults = DEFAULT_SELECTED_WORD_PANEL_ITEMS.map((item) => ({ ...item }));
  if (!Array.isArray(value)) return defaults;

  const knownIds = new Set<WhSelectedWordPanelItemId>(SELECTED_WORD_PANEL_ITEM_IDS);
  const seen = new Set<WhSelectedWordPanelItemId>();
  const normalized: WhSelectedWordPanelItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !knownIds.has(item.id as WhSelectedWordPanelItemId)) continue;
    const id = item.id as WhSelectedWordPanelItemId;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, visible: item.visible !== false });
  }
  for (const item of defaults) {
    if (!seen.has(item.id)) normalized.push(item);
  }
  return normalized;
}

function objectEntries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

function objectArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === "string") : [];
}

export function normalizeReaderBookmarks(value: unknown): Record<string, WhReaderBookmark[]> {
  const colors = new Set<WhReaderBookmarkColor>(["amber", "red", "green", "blue", "purple"]);
  const result: Record<string, WhReaderBookmark[]> = {};
  for (const [textId, rawBookmarks] of objectEntries(value)) {
    if (!textId || !Array.isArray(rawBookmarks)) continue;
    const seen = new Set<string>();
    const bookmarks: WhReaderBookmark[] = [];
    for (const raw of rawBookmarks) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      const id = raw.id.trim().slice(0, 128);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      bookmarks.push({
        id,
        label: typeof raw.label === "string" ? raw.label.trim().replace(/\s+/g, " ").slice(0, 160) : "",
        ...(colors.has(raw.color as WhReaderBookmarkColor) ? { color: raw.color as WhReaderBookmarkColor } : {}),
        page: Math.min(1_000_000, Math.max(1, Math.trunc(Number(raw.page) || 1))),
        scrollTop: Math.min(1_000_000_000, Math.max(0, Math.round(Number(raw.scrollTop) || 0))),
        wordIndex: Number.isInteger(raw.wordIndex) && Number(raw.wordIndex) >= 0 ? Number(raw.wordIndex) : null,
        ...(Number.isInteger(raw.anchorOffset) && Number(raw.anchorOffset) >= 0
          ? { anchorOffset: Number(raw.anchorOffset) }
          : {}),
        ...(typeof raw.anchorWord === "string" && raw.anchorWord.trim() ? { anchorWord: raw.anchorWord.trim().slice(0, 160) } : {}),
        ...(typeof raw.anchorBefore === "string" && raw.anchorBefore.trim() ? { anchorBefore: raw.anchorBefore.trim().slice(0, 160) } : {}),
        ...(typeof raw.anchorAfter === "string" && raw.anchorAfter.trim() ? { anchorAfter: raw.anchorAfter.trim().slice(0, 160) } : {}),
        ...(raw.wordAlgorithm === "classic" || raw.wordAlgorithm === "modern" ? { wordAlgorithm: raw.wordAlgorithm } : {}),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : ""
      });
      if (bookmarks.length >= 200) break;
    }
    if (bookmarks.length) result[textId] = bookmarks;
  }
  return result;
}

export class UnsupportedStateSchemaError extends Error {
  constructor(source: string, version: unknown) {
    super(`${source} schema version ${version || "missing"} is not supported`);
    this.name = "UnsupportedStateSchemaError";
  }
}

export function assertSupportedStateSchemaVersion(
  value: unknown,
  source = "state payload"
): asserts value is WhBridgeSnapshot {
  if (!isRecord(value)) throw new UnsupportedStateSchemaError(source, "missing");
  const version = Number(value.schemaVersion);
  if (version !== STATE_SCHEMA_VERSION) {
    throw new UnsupportedStateSchemaError(source, value.schemaVersion);
  }
}

function normalizeSyncConflicts(value: unknown): WhSyncConflict[] {
  return objectArray(value).map((conflict) => ({
    id: typeof conflict.id === "string" ? conflict.id : "",
    key: typeof conflict.key === "string" ? conflict.key : "",
    reason: typeof conflict.reason === "string" ? conflict.reason : "",
    timestamp: typeof conflict.timestamp === "string" ? conflict.timestamp : "",
    kept: isRecord(conflict.kept) ? conflict.kept : {},
    conflict: isRecord(conflict.conflict) ? conflict.conflict : {}
  })).filter((conflict) => conflict.id);
}

function normalizeRecoveryItems(value: unknown): WhRecord[] {
  return objectArray(value).map((item) => ({
    path: typeof item.path === "string" ? item.path : "",
    kind: typeof item.kind === "string" ? item.kind : "",
    error: typeof item.error === "string" ? item.error : ""
  })).filter((item) => item.path || item.error);
}

function normalizeRecoveryStatus(value: unknown): WhRecoveryStatus | null {
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

function normalizeVocabEntries(rawVocab: unknown): WhVocabulary {
  const vocab: WhVocabulary = {};
  for (const [word, entry] of objectEntries(rawVocab)) {
    if (!isRecord(entry)) continue;
    if (!isVocabStatus(entry.status)) entry.status = "new";
    if (typeof entry.article === "string") {
      entry.article = entry.article.trim();
      if (!entry.article) delete entry.article;
    } else {
      delete entry.article;
    }
    if (typeof entry.interval !== "number" || !Number.isFinite(entry.interval)) entry.interval = 0;
    if (typeof entry.repetition !== "number" || !Number.isFinite(entry.repetition)) entry.repetition = 0;
    if (typeof entry.efactor !== "number" || !Number.isFinite(entry.efactor)) entry.efactor = 2.5;
    if (typeof entry.stability !== "number" || !Number.isFinite(entry.stability)) entry.stability = 0;
    if (typeof entry.difficulty !== "number" || !Number.isFinite(entry.difficulty)) entry.difficulty = 5;
    if (entry.srsAlgorithm !== "fsrs") entry.srsAlgorithm = "sm2";
    if (!entry.nextDate) entry.nextDate = new Date().toISOString().slice(0, 10);
    vocab[word] = entry as WhVocabEntry;
  }
  return vocab;
}

function createEmptyProfile(lang: string): WhProfile {
  return {
    vocab: {},
    customTexts: [],
    userBooks: [],
    hiddenBuiltInBooks: [],
    archivedBookIds: [],
    preferences: { dictionaryUrl: getDefaultDictionaryUrl(lang), dictionaryMode: "internal" }
  };
}

function normalizeProfile(rawProfile: unknown, lang: string): WhProfile {
  const profile: UnknownRecord = isRecord(rawProfile) ? rawProfile : createEmptyProfile(lang);
  profile.vocab = normalizeVocabEntries(profile.vocab);
  profile.customTexts = objectArray(profile.customTexts)
    .filter((text) => text.id !== "gutenberg-full-undefined") as WhText[];
  profile.userBooks = objectArray(profile.userBooks) as WhText[];
  cleanSavedCatalogTitles(profile.userBooks);
  profile.hiddenBuiltInBooks = stringArray(profile.hiddenBuiltInBooks);
  profile.archivedBookIds = stringArray(profile.archivedBookIds);
  const preferences = isRecord(profile.preferences) ? profile.preferences : {};
  profile.preferences = preferences;
  delete preferences.theme;
  delete preferences.darkMode;
  preferences.translationSourceLanguage = normalizeTranslationLanguageCode(preferences.translationSourceLanguage);
  preferences.translationTargetLanguage = normalizeTranslationLanguageCode(preferences.translationTargetLanguage);
  return profile as WhProfile;
}

function normalizeProfiles(rawProfiles: unknown): Record<string, WhProfile> {
  return Object.fromEntries(
    objectEntries(rawProfiles)
      .filter(([lang]) => lang)
      .map(([lang, profile]) => [lang, normalizeProfile(profile, lang)])
  );
}

export function normalizeState(nextState: WhRecord): WhAppState {
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
  nextState.preferences.selectedWordPanelItems = normalizeSelectedWordPanelItems(rawPreferences.selectedWordPanelItems);
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
  nextState.preferences.readerBookmarks = normalizeReaderBookmarks(rawPreferences.readerBookmarks);
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
  for (const [profileLang, profile] of Object.entries(nextState.profiles as Record<string, WhProfile>)) {
    if (nonDikiLanguages.includes(profileLang) && profile.preferences?.dictionaryUrl?.includes("diki.pl")) {
      profile.preferences.dictionaryUrl = getDefaultDictionaryUrl(profileLang);
    }
  }
  if (nonDikiLanguages.includes(lang) && nextState.preferences.dictionaryUrl.includes("diki.pl")) {
    nextState.preferences.dictionaryUrl = getDefaultDictionaryUrl(lang);
  }

  return nextState as WhAppState;
}

export function loadState(): WhAppState {
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
        customTexts: [] as WhText[],
        userBooks: [] as WhText[],
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
          const textLang = typeof text.lang === "string" ? text.lang : "";
          const preferredLang = typeof merged.preferences.learningLanguage === "string"
            ? merged.preferences.learningLanguage
            : "de";
          const targetLang = textLang || prefixLang || preferredLang;
          const rawTargetProfile = merged.profiles[targetLang];
          const profile = isRecord(rawTargetProfile)
            ? rawTargetProfile
            : (merged.profiles[targetLang] = createEmptyProfile(targetLang));
          const customTexts = Array.isArray(profile.customTexts) ? profile.customTexts as unknown[] : [];
          profile.customTexts = customTexts;
          customTexts.push(text);
        }
      }
      const bridgeUiState = isRecord(snap.uiState) && snap.uiState.schemaVersion === STATE_SCHEMA_VERSION
        ? captureUiState(snap.uiState)
        : loadUiStateCache();
      Object.assign(merged, bridgeUiState);
      return normalizeState(merged);
    } catch (error) {
      console.warn("Bridge state load failed", error);
      throw error;
    }
  }
  if (window.__qtBridge || window.WordHunterAndroid) {
    return normalizeState({ ...fallback, ...loadUiStateCache() });
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    assertSupportedStateSchemaVersion(parsed, "localStorage cache");
    return normalizeState({ ...fallback, ...parsed });
  } catch (error) {
    console.warn("Failed to read localStorage", error);
    return fallback;
  }
}
