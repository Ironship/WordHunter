// DOM reference cache. Only collects elements, does not render.
export const els: WhDomCache = {};

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function cacheElements() {
  els.pageTitle = byId("page-title");
  els.overallCount = byId("overall-count");
  els.pillKnown = byId("pill-known");
  els.pillLearning = byId("pill-learning");
  els.pillNew = byId("pill-new");
  els.themeToggle = byId("theme-toggle");
  els.pocketNavigationToggle = byId("pocket-navigation-toggle");
  els.navItems = [...document.querySelectorAll<HTMLElement>(".nav-item")];
  els.translatorNavItem = document.querySelector<HTMLElement>('[data-view="translator"]');
  els.views = [...document.querySelectorAll<HTMLElement>(".view")];

  els.textSelect = byId("text-select");
  els.readerHeading = byId("reader-heading");
  els.readerSource = byId("reader-source");
  els.readerText = byId("reader-text");
  els.readerFindInput = byId("reader-find-input");
  els.readerFindCount = byId("reader-find-count");
  els.readerFindPrev = byId("reader-find-prev");
  els.readerFindNext = byId("reader-find-next");
  els.readerFindClose = byId("reader-find-close");
  els.readerFindToggle = byId("reader-find-toggle");
  els.readerHighlightToggle = byId("reader-highlight-toggle");
  els.readerWordPanelToggle = byId("reader-word-panel-toggle");
  els.readerPreviousWord = byId("reader-previous-word");
  els.readerNextWord = byId("reader-next-word");
  els.readerFontSizeSlider = byId("reader-font-size-slider");
  els.readerFontSizeValue = byId("reader-font-size-value");
  els.trackingSummary = byId("tracking-summary");
  els.uniqueSummary = byId("unique-summary");
  els.progressBar = byId("progress-bar");
  els.progressBarLearning = byId("progress-bar-learning");
  els.wordPanel = byId("word-panel");
  els.readerSidebarResizer = byId("reader-sidebar-resizer");

  els.translatorFrom = byId("translator-from");
  els.translatorTo = byId("translator-to");
  els.translatorSwap = byId("translator-swap");
  els.translatorSource = byId("translator-source");
  els.translatorResult = byId("translator-result");
  els.translatorStatus = byId("translator-status");
  els.translatorProgress = byId("translator-progress");
  els.translatorAiExplain = byId("translator-ai-explain");
  els.translatorAiResult = byId("translator-ai-result");

  els.vocabSearch = byId("vocab-search");
  els.vocabTextFilter = byId("vocab-text-filter");
  els.exportVocabTxt = byId("export-vocab-txt");
  els.exportVocabAnki = byId("export-vocab-anki");
  els.vocabStatusFilter = byId("vocab-status-filter");
  els.vocabStatusFilters = [...document.querySelectorAll<HTMLInputElement>("[data-vocab-status-filter]")];
  els.vocabTableBody = byId("vocab-table-body");
  els.reviewCard = byId("review-card");
  els.reviewChart = byId("review-chart-fullwidth");
  els.reviewUpcoming = byId("review-upcoming");
  els.reviewReverseToggle = byId("review-reverse-toggle");
  els.reviewReverseLabel = byId("review-reverse-label");

  els.exportAnkiTsv = byId("export-anki-tsv");
  els.importAnkiTsv = byId("import-anki-tsv");
  els.ankiExportStatusFilters = [...document.querySelectorAll<HTMLInputElement>("[data-anki-export-status]")];
  els.clearWords = byId("clear-words");
  els.clearLibrary = byId("clear-library");
  els.prefLocales = [
    byId<HTMLSelectElement>("pref-locale-sidebar"),
  ].filter(Boolean);
  els.prefLearningLanguages = [
    byId<HTMLSelectElement>("pref-learning-language-sidebar"),
  ].filter(Boolean);
  els.prefLocale = els.prefLocales[0] || null;
  els.prefLearningLanguage = els.prefLearningLanguages[0] || null;
  // Settings controls are TS-rendered (#127 P3): resolve lazily so
  // consumers work whether the renderer ran yet or not.
  function lazySettingsEl(key: keyof WhDomCache, id: string): void {
    Object.defineProperty(els, key, {
      get: () => document.getElementById(id),
      configurable: true
    });
  }
  lazySettingsEl("prefFont", "pref-font");
  lazySettingsEl("prefLineHeight", "pref-line-height");
  lazySettingsEl("prefWordsPerPage", "pref-words-per-page");
  lazySettingsEl("prefWordAlgorithm", "pref-word-algorithm");
  lazySettingsEl("prefFontSize", "pref-font-size");
  lazySettingsEl("prefFontSizeLabel", "pref-font-size-label");
  lazySettingsEl("prefHighlight", "pref-highlight");
  lazySettingsEl("prefHideKnown", "pref-hide-known");
  lazySettingsEl("prefInTextReview", "pref-in-text-review");
  lazySettingsEl("prefAutoLearn", "pref-auto-learn");
  lazySettingsEl("prefAutoTranslate", "pref-auto-translate");
  lazySettingsEl("prefAutoTranslateRow", "pref-auto-translate-row");
  lazySettingsEl("prefOfflineTranslator", "pref-offline-translator");
  lazySettingsEl("prefTranslationProvider", "pref-translation-provider");
  lazySettingsEl("prefTranslationLanguageSettings", "pref-translation-language-settings");
  lazySettingsEl("prefTranslationSourceLanguage", "pref-translation-source-language");
  lazySettingsEl("prefTranslationTargetLanguage", "pref-translation-target-language");
  lazySettingsEl("prefDeepLApiKey", "pref-deepl-api-key");
  lazySettingsEl("prefDeepLApiKeyRow", "pref-deepl-key-row");
  lazySettingsEl("prefLmStudioEndpoint", "pref-lmstudio-endpoint");
  lazySettingsEl("prefLmStudioEndpointRow", "pref-lmstudio-endpoint-row");
  lazySettingsEl("prefLmStudioModel", "pref-lmstudio-model");
  lazySettingsEl("prefLmStudioModelRow", "pref-lmstudio-model-row");
  lazySettingsEl("prefArgosAsDict", "pref-argos-as-dict");
  lazySettingsEl("prefArgosAsDictRow", "pref-argos-as-dict-row");
  lazySettingsEl("prefDictionaryUrl", "pref-dictionary-url");
  lazySettingsEl("prefDictionaryMode", "pref-dictionary-mode");
  lazySettingsEl("prefYouglishMode", "pref-youglish-mode");
  lazySettingsEl("prefTextAlign", "pref-text-align");
  lazySettingsEl("prefMaxWidth", "pref-max-width");
  lazySettingsEl("prefReaderFocusMode", "pref-reader-focus-mode");
  lazySettingsEl("prefReaderWordPanelVisible", "pref-reader-word-panel-visible");
  lazySettingsEl("prefSelectedWordPanelItems", "pref-selected-word-panel-items");
  lazySettingsEl("prefTtsRate", "pref-tts-rate");
  lazySettingsEl("prefAutoTtsOnWordFocus", "pref-auto-tts-on-word-focus");
  lazySettingsEl("prefTtsWordHighlight", "pref-tts-word-highlight");
  lazySettingsEl("prefStatusSoundsEnabled", "pref-status-sounds-enabled");
  lazySettingsEl("prefStatusSoundVolume", "pref-status-sound-volume");
  lazySettingsEl("prefStatusSoundVolumeLabel", "pref-status-sound-volume-label");
  lazySettingsEl("prefUseEdgeTts", "pref-use-edge-tts");


  els.discoverForm = byId("discover-form");
  els.discoverQuery = byId("discover-query");
  els.discoverSource = byId("discover-source");
  els.discoverSort = byId("discover-sort");
  els.discoverLevel = byId("discover-level");
  els.discoverResults = byId("discover-results");
  els.discoverPagination = byId("discover-pagination");
  els.discoverToolbar = byId("discover-toolbar");
  els.discoverStatus = byId("discover-status");
  els.discoverSelectAll = byId("discover-select-all");
  els.discoverClear = byId("discover-clear");
  els.discoverAddSelected = byId("discover-add-selected");
  els.userBooksList = byId("user-books-list");
}
