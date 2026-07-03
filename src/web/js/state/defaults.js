import { STATE_SCHEMA_VERSION, UI_SCALE } from "../constants.js";
import { VOCAB_STATUS_FILTERS } from "../events/vocab-status.js";
import { DEFAULT_LEARNING_COLORS } from "../reader-colors.js";

export function normalizeVocabStatusFilters(value, legacyValue) {
  if (Array.isArray(value)) return value.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  if (legacyValue === "all") return [...VOCAB_STATUS_FILTERS];
  if (legacyValue === "not_ignored") return ["new", "learning", "known"];
  if (VOCAB_STATUS_FILTERS.includes(legacyValue)) return [legacyValue];
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
    grc: "https://logeion.uchicago.edu/{{word}}"
  };
  return urls[lang] || urls.en;
}

export function createDefaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
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
    syncConflictCount: 0,
    syncConflicts: [],
    recoveryStatus: null,
    migrationStatus: null,
    filters: {
      libraryQuery: "",
      libraryLevel: "all",
      librarySort: "title",
      librarySortReverse: false,
      libraryArchive: "active",
      vocabQuery: "",
      vocabStatus: "all",
      vocabStatuses: ["learning", "known"],
      vocabTextId: "all"
    },
    discover: { query: "", source: "gutenberg", sort: "popular", level: "", page: 1 },
    preferences: {
      theme: "auto",
      locale: "en",
      languageOnboardingDone: false,
      readerFont: "serif",
      readerLineHeight: "normal",
      highlightTokens: true,
      hideKnownIgnored: true,
      inTextReview: true,
      dynamicLearningColors: true,
      learningColors: [...DEFAULT_LEARNING_COLORS],
      autoLearnOnClick: false,
      autoAddLearningOnly: true,
      showCardStats: true,
      showCovers: true,
      learningLanguage: "de",
      dictionaryUrl: "",
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
      ttsWordHighlight: false,
      reviewReverse: false,
      srsAlgorithm: "fsrs",
      removalBehavior: "ignored",
      useEdgeTts: true,
      autoTranslateWords: true,
      translationProvider: "google",
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
