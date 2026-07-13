// @ts-check

import { STATE_SCHEMA_VERSION, UI_SCALE } from "../constants.js";
import { VOCAB_STATUS_FILTERS } from "../events/vocab-status.js";
import { DEFAULT_LEARNING_COLORS } from "../reader-colors.js";
import { DEFAULT_THEME } from "../theme.js";

export function normalizeVocabStatusFilters(value) {
  if (Array.isArray(value)) return value.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  return [...VOCAB_STATUS_FILTERS];
}

export function normalizeAnkiExportStatuses(value) {
  if (!Array.isArray(value)) return ["learning"];
  const statuses = value.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  return statuses.length ? statuses : ["learning"];
}

export function getDefaultDictionaryUrl(lang) {
  const urls = {
    en: "https://www.diki.pl/slownik-angielskiego?q={{word}}",
    de: "https://www.diki.pl/slownik-niemieckiego?q={{word}}",
    es: "https://www.diki.pl/slownik-hiszpanskiego?q={{word}}",
    it: "https://www.diki.pl/slownik-wloskiego?q={{word}}",
    fr: "https://www.diki.pl/slownik-francuskiego?q={{word}}",
    pl: "https://sjp.pwn.pl/szukaj/{{word}}.html",
    uk: "https://translate.google.com/?sl=uk&tl=pl&text={{word}}&op=translate",
    ru: "https://translate.google.com/?sl=ru&tl=pl&text={{word}}&op=translate",
    ja: "https://jisho.org/search/{{word}}",
    zh: "https://www.mdbg.net/chinese/dictionary?page=worddict&wdrst=0&wdqb={{word}}",
    la: "https://logeion.uchicago.edu/{{word}}",
    grc: "https://logeion.uchicago.edu/{{word}}",
    other: "https://en.wiktionary.org/wiki/{{word}}"
  };
  return urls[lang] || urls.en;
}

export function createDefaultState() {
  const defaultProfile = {
    vocab: {},
    customTexts: [],
    userBooks: [],
    hiddenBuiltInBooks: [],
    archivedBookIds: [],
    preferences: { dictionaryUrl: getDefaultDictionaryUrl("de"), dictionaryMode: "internal" }
  };
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    currentView: "library",
    currentTextId: null,
    selectedWord: null,
    selectedWordIndex: null,
    readerSelectionRange: null,
    customTexts: defaultProfile.customTexts,
    userBooks: defaultProfile.userBooks,
    hiddenBuiltInBooks: defaultProfile.hiddenBuiltInBooks,
    archivedBookIds: defaultProfile.archivedBookIds,
    vocab: defaultProfile.vocab,
    profiles: { de: defaultProfile },
    reviewIndex: 0,
    readerFontSize: 18,
    readerPdfZoom: 1,
    readerPdfViewMode: "overlay",
    readerPage: 1,
    readerPages: {},
    readerScrolls: {},
    readerScrollsPerPage: {},
    dataDirectory: "",
    syncDirectory: "",
    syncHealth: null,
    cloudSyncStatus: null,
    syncthingStatus: null,
    syncConflictCount: 0,
    syncConflicts: [],
    recoveryStatus: null,
    filters: {
      libraryQuery: "",
      libraryLevel: "all",
      librarySort: "title",
      librarySortReverse: false,
      libraryArchive: "active",
      vocabQuery: "",
      vocabStatuses: ["learning", "known"],
      vocabTextId: "all"
    },
    discover: { query: "", source: "gutenberg", sort: "popular", level: "", page: 1 },
    preferences: {
      theme: DEFAULT_THEME,
      locale: "en",
      languageOnboardingDone: false,
      readerFont: "serif",
      readerFontSize: 18,
      readerLineHeight: "normal",
      highlightTokens: true,
      hideKnownIgnored: true,
      inTextReview: true,
      dynamicLearningColors: true,
      learningColors: [...DEFAULT_LEARNING_COLORS],
      autoLearnOnClick: false,
      autoAddLearningOnly: true,
      showCardStats: true,
      cardStatsMode: "percentages",
      showCovers: true,
      learningLanguage: "de",
      dictionaryUrl: defaultProfile.preferences.dictionaryUrl,
      dictionaryMode: "internal",
      readerTextAlign: "left",
      readerMaxWidth: "wide",
      readerFocusMode: false,
      readerWordPanelVisible: true,
      touchControls: false,
      readerSidebarWidth: 380,
      librarySidebarWidth: 360,
      ttsRate: "normal",
      autoTtsOnWordFocus: true,
      ttsWordHighlight: true,
      ttsWordHighlightDefaultVersion: 1,
      statusSoundsEnabled: true,
      statusSoundVolume: 0.55,
      reviewReverse: false,
      srsAlgorithm: "fsrs",
      removalBehavior: "ignored",
      useEdgeTts: true,
      autoTranslateWords: true,
      translationProvider: "google",
      translationSourceLanguage: "",
      translationTargetLanguage: "",
      deeplApiKey: "",
      lmStudioEndpoint: "http://127.0.0.1:1234/v1/chat/completions",
      lmStudioModel: "",
      ankiExportStatuses: ["learning"],
      wordDetectionAlgorithm: "modern",
      uiScale: UI_SCALE.DEFAULT,
      lastReadTextIds: {},
      skippedVersion: "",
      disableUpdateCheck: false,
      wordsPerPage: 1000,
      argosAsDict: false,
      offlineTranslator: false,
      colorNew: "#ff6b6b",
      colorLearning: "#ffb84d",
      colorKnown: "#8ce99a",
      colorIgnored: "#ced4da",
      reviewGraphType: "heatmap",
      graphRange: "recent"
    }
  };
}
