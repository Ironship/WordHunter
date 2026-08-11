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

  els.bookList = byId("book-list");
  els.libraryPanel = document.querySelector<HTMLElement>(".library-panel");
  els.libraryFiltersToggle = byId("library-filters-toggle");
  els.librarySearch = byId("library-search");
  els.levelFilter = byId("level-filter");
  els.librarySort = byId("library-sort");
  els.librarySortReverse = byId("library-sort-reverse");
  els.libraryArchiveFilter = byId("library-archive-filter");
  els.importForm = byId("import-form");
  els.importModeSelect = byId("import-mode-select");
  els.importBooksMode = byId("import-books-mode");
  els.importYoutubeMode = byId("import-youtube-mode");
  els.importYoutubeUrl = byId("import-youtube-url");
  els.importYoutubeLoad = byId("import-youtube-load");
  els.importYoutubeTrack = byId("import-youtube-track");
  els.importYoutubeStatus = byId("import-youtube-status");
  els.importTitle = byId("import-title");
  els.importAuthor = byId("import-author");
  els.importTags = byId("import-tags");
  els.importLevel = byId("import-level");
  els.importText = byId("import-text");
  els.importFile = byId("import-file");
  els.importCover = byId("import-cover");
  els.importCoverPreview = byId("import-cover-preview");
  els.importCoverImg = byId("import-cover-img");
  els.importCoverClear = byId("import-cover-clear");
  els.librarySidebarResizer = byId("library-sidebar-resizer");

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
  els.resetPrefs = byId("reset-prefs");
  els.prefRemovalBehavior = byId("pref-removal-behavior");
  els.prefTheme = byId("pref-theme");
  els.prefLocales = [
    byId<HTMLSelectElement>("pref-locale-sidebar"),
    byId<HTMLSelectElement>("pref-locale-settings"),
  ].filter(Boolean);
  els.prefLearningLanguages = [
    byId<HTMLSelectElement>("pref-learning-language-sidebar"),
    byId<HTMLSelectElement>("pref-learning-language-settings"),
  ].filter(Boolean);
  els.prefLocale = els.prefLocales[0] || null;
  els.prefLearningLanguage = els.prefLearningLanguages[0] || null;
  els.prefColorNew = byId("pref-color-new");
  els.prefColorLearning = byId("pref-color-learning");
  els.prefColorKnown = byId("pref-color-known");
  els.prefColorIgnored = byId("pref-color-ignored");
  els.prefDynamicLearningColors = byId("pref-dynamic-learning-colors");
  els.prefLearningColors = [...document.querySelectorAll<HTMLInputElement>("[data-learning-color]")];
  els.prefLearningColorsRow = byId("pref-learning-colors-row");
  els.prefFont = byId("pref-font");
  els.prefLineHeight = byId("pref-line-height");
  els.prefWordsPerPage = byId("pref-words-per-page");
  els.prefWordAlgorithm = byId("pref-word-algorithm");
  els.prefSrsAlgorithm = byId("pref-srs-algorithm");
  els.prefFontSize = byId("pref-font-size");
  els.prefFontSizeLabel = byId("pref-font-size-label");
  els.prefUiScale = byId("pref-ui-scale");
  els.prefUiScaleLabel = byId("pref-ui-scale-label");
  els.prefTouchControls = byId("pref-touch-controls");
  els.prefHighlight = byId("pref-highlight");
  els.prefHideKnown = byId("pref-hide-known");
  els.prefInTextReview = byId("pref-in-text-review");
  els.prefReviewGraphType = byId("pref-review-graph-type");
  els.prefAutoLearn = byId("pref-auto-learn");
  els.prefAutoAddLearning = byId("pref-auto-add-learning");
  els.prefAutoTranslate = byId("pref-auto-translate");
  els.prefAutoTranslateRow = byId("pref-auto-translate-row");
  els.prefOfflineTranslator = byId("pref-offline-translator");
  els.prefTranslationProvider = byId("pref-translation-provider");
  els.prefTranslationLanguageSettings = byId("pref-translation-language-settings");
  els.prefTranslationSourceLanguage = byId("pref-translation-source-language");
  els.prefTranslationTargetLanguage = byId("pref-translation-target-language");
  els.prefDeepLApiKey = byId("pref-deepl-api-key");
  els.prefDeepLApiKeyRow = byId("pref-deepl-key-row");
  els.prefLmStudioEndpoint = byId("pref-lmstudio-endpoint");
  els.prefLmStudioEndpointRow = byId("pref-lmstudio-endpoint-row");
  els.prefLmStudioModel = byId("pref-lmstudio-model");
  els.prefLmStudioModelRow = byId("pref-lmstudio-model-row");
  els.prefAiExplanations = byId("pref-ai-explanations");
  els.prefAiEndpoint = byId("pref-ai-endpoint");
  els.prefAiEndpointRow = byId("pref-ai-endpoint-row");
  els.prefAiModel = byId("pref-ai-model");
  els.prefAiModelRow = byId("pref-ai-model-row");
  els.prefAiApiKey = byId("pref-ai-api-key");
  els.prefAiApiKeyRow = byId("pref-ai-key-row");
  els.prefAiEffort = byId("pref-ai-effort");
  els.prefAiEffortRow = byId("pref-ai-effort-row");
  els.prefAiAutoTrigger = byId("pref-ai-auto-trigger");
  els.prefAiAutoTriggerRow = byId("pref-ai-auto-trigger-row");
  els.prefArgosAsDict = byId("pref-argos-as-dict");
  els.prefArgosAsDictRow = byId("pref-argos-as-dict-row");
  els.prefDictionaryUrl = byId("pref-dictionary-url");
  els.prefDictionaryMode = byId("pref-dictionary-mode");
  els.prefYouglishMode = byId("pref-youglish-mode");
  els.prefCardStats = byId("pref-card-stats");
  els.prefCardStatsMode = byId("pref-card-stats-mode");
  els.prefCardStatsModeRow = byId("pref-card-stats-mode-row");
  els.prefCovers = byId("pref-covers");
  els.ocrGpuStatus = byId("ocr-gpu-status");
  els.prefTextAlign = byId("pref-text-align");
  els.prefMaxWidth = byId("pref-max-width");
  els.prefReaderFocusMode = byId("pref-reader-focus-mode");
  els.prefReaderWordPanelVisible = byId("pref-reader-word-panel-visible");
  els.prefSelectedWordPanelItems = document.getElementById("pref-selected-word-panel-items");
  els.prefTtsRate = byId("pref-tts-rate");
  els.prefAutoTtsOnWordFocus = byId("pref-auto-tts-on-word-focus");
  els.prefAutoTtsOnFlashcardOpen = byId("pref-auto-tts-on-flashcard-open");
  els.prefTtsWordHighlight = byId("pref-tts-word-highlight");
  els.prefStatusSoundsEnabled = byId("pref-status-sounds-enabled");
  els.prefStatusSoundVolume = byId("pref-status-sound-volume");
  els.prefStatusSoundVolumeLabel = byId("pref-status-sound-volume-label");
  els.prefUseEdgeTts = byId("pref-use-edge-tts");

  els.storageSummary = byId("storage-summary");
  els.dataDirectory = byId("data-directory");
  els.recoveryStatusPanel = byId("recovery-status-panel");
  els.recoveryStatusList = byId("recovery-status-list");
  els.chooseDataDirectory = byId("choose-data-directory");

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
