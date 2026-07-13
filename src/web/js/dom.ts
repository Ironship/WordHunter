// DOM reference cache. Only collects elements, does not render.
export const els: WhDomCache = {};

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function cacheElements() {
  els.pageTitle = document.getElementById("page-title");
  els.overallCount = document.getElementById("overall-count");
  els.pillKnown = document.getElementById("pill-known");
  els.pillLearning = document.getElementById("pill-learning");
  els.pillNew = document.getElementById("pill-new");
  els.themeToggle = document.getElementById("theme-toggle");
  els.pocketNavigationToggle = document.getElementById("pocket-navigation-toggle");
  els.navItems = [...document.querySelectorAll<HTMLElement>(".nav-item")];
  els.translatorNavItem = document.querySelector('[data-view="translator"]');
  els.views = [...document.querySelectorAll<HTMLElement>(".view")];

  els.bookList = document.getElementById("book-list");
  els.libraryPanel = document.querySelector(".library-panel");
  els.libraryFiltersToggle = document.getElementById("library-filters-toggle");
  els.librarySearch = byId("library-search");
  els.levelFilter = byId("level-filter");
  els.librarySort = byId("library-sort");
  els.librarySortReverse = byId("library-sort-reverse");
  els.libraryArchiveFilter = byId("library-archive-filter");
  els.importForm = byId("import-form");
  els.importYoutubeUrl = byId("import-youtube-url");
  els.importYoutubeLoad = byId("import-youtube-load");
  els.importYoutubeTrack = byId("import-youtube-track");
  els.importYoutubeStatus = document.getElementById("import-youtube-status");
  els.importTitle = byId("import-title");
  els.importAuthor = byId("import-author");
  els.importTags = byId("import-tags");
  els.importLevel = byId("import-level");
  els.importText = byId("import-text");
  els.importFile = byId("import-file");
  els.importCover = byId("import-cover");
  els.importCoverPreview = document.getElementById("import-cover-preview");
  els.importCoverImg = byId("import-cover-img");
  els.importCoverClear = document.getElementById("import-cover-clear");
  els.librarySidebarResizer = document.getElementById("library-sidebar-resizer");

  els.textSelect = byId("text-select");
  els.readerHeading = document.getElementById("reader-heading");
  els.readerSource = document.getElementById("reader-source");
  els.readerText = document.getElementById("reader-text");
  els.readerHighlightToggle = document.getElementById("reader-highlight-toggle");
  els.readerWordPanelToggle = document.getElementById("reader-word-panel-toggle");
  els.readerPreviousWord = document.getElementById("reader-previous-word");
  els.readerNextWord = document.getElementById("reader-next-word");
  els.readerFontSizeSlider = byId("reader-font-size-slider");
  els.readerFontSizeValue = document.getElementById("reader-font-size-value");
  els.trackingSummary = document.getElementById("tracking-summary");
  els.uniqueSummary = document.getElementById("unique-summary");
  els.progressBar = document.getElementById("progress-bar");
  els.progressBarLearning = document.getElementById("progress-bar-learning");
  els.wordPanel = document.getElementById("word-panel");
  els.readerSidebarResizer = document.getElementById("reader-sidebar-resizer");

  els.translatorFrom = byId("translator-from");
  els.translatorTo = byId("translator-to");
  els.translatorSwap = byId("translator-swap");
  els.translatorSource = byId("translator-source");
  els.translatorResult = byId("translator-result");
  els.translatorStatus = document.getElementById("translator-status");
  els.translatorProgress = document.getElementById("translator-progress");

  els.vocabSearch = byId("vocab-search");
  els.vocabTextFilter = byId("vocab-text-filter");
  els.exportVocabTxt = document.getElementById("export-vocab-txt");
  els.exportVocabAnki = document.getElementById("export-vocab-anki");
  els.vocabStatusFilter = byId("vocab-status-filter");
  els.vocabStatusFilters = [...document.querySelectorAll<HTMLInputElement>("[data-vocab-status-filter]")];
  els.vocabTableBody = byId("vocab-table-body");
  els.reviewCard = document.getElementById("review-card");
  els.reviewChart = document.getElementById("review-chart-fullwidth");
  els.reviewUpcoming = document.getElementById("review-upcoming");
  els.reviewReverseToggle = document.getElementById("review-reverse-toggle");
  els.reviewReverseLabel = document.getElementById("review-reverse-label");

  els.exportState = document.getElementById("export-state");
  els.importState = document.getElementById("import-state");
  els.exportAnkiTsv = document.getElementById("export-anki-tsv");
  els.importAnkiTsv = document.getElementById("import-anki-tsv");
  els.ankiExportStatusFilters = [...document.querySelectorAll<HTMLInputElement>("[data-anki-export-status]")];
  els.clearWords = document.getElementById("clear-words");
  els.clearLibrary = document.getElementById("clear-library");
  els.clearState = document.getElementById("clear-state");
  els.resetPrefs = document.getElementById("reset-prefs");
  els.prefRemovalBehavior = document.getElementById("pref-removal-behavior");
  els.prefTheme = byId("pref-theme");
  els.prefLocales = [
    byId<HTMLSelectElement>("pref-locale-sidebar"),
    byId<HTMLSelectElement>("pref-locale-settings"),
    byId<HTMLSelectElement>("pref-locale-onboarding"),
  ].filter(Boolean);
  els.prefLearningLanguages = [
    byId<HTMLSelectElement>("pref-learning-language-sidebar"),
    byId<HTMLSelectElement>("pref-learning-language-settings"),
    byId<HTMLSelectElement>("pref-learning-language-onboarding"),
  ].filter(Boolean);
  els.prefLocale = els.prefLocales[0] || null;
  els.prefLearningLanguage = els.prefLearningLanguages[0] || null;
  els.languageOnboardingDialog = byId("language-onboarding-dialog");
  els.languageOnboardingDone = document.getElementById("language-onboarding-done");
  els.prefColorNew = document.getElementById("pref-color-new");
  els.prefColorLearning = document.getElementById("pref-color-learning");
  els.prefColorKnown = document.getElementById("pref-color-known");
  els.prefColorIgnored = document.getElementById("pref-color-ignored");
  els.prefDynamicLearningColors = document.getElementById("pref-dynamic-learning-colors");
  els.prefLearningColors = [...document.querySelectorAll<HTMLInputElement>("[data-learning-color]")];
  els.prefLearningColorsRow = document.getElementById("pref-learning-colors-row");
  els.prefFont = document.getElementById("pref-font");
  els.prefLineHeight = document.getElementById("pref-line-height");
  els.prefWordsPerPage = document.getElementById("pref-words-per-page");
  els.prefWordAlgorithm = document.getElementById("pref-word-algorithm");
  els.prefSrsAlgorithm = document.getElementById("pref-srs-algorithm");
  els.prefFontSize = document.getElementById("pref-font-size");
  els.prefFontSizeLabel = document.getElementById("pref-font-size-label");
  els.prefUiScale = document.getElementById("pref-ui-scale");
  els.prefUiScaleLabel = document.getElementById("pref-ui-scale-label");
  els.prefTouchControls = document.getElementById("pref-touch-controls");
  els.prefHighlight = document.getElementById("pref-highlight");
  els.prefHideKnown = document.getElementById("pref-hide-known");
  els.prefInTextReview = document.getElementById("pref-in-text-review");
  els.prefReviewGraphType = document.getElementById("pref-review-graph-type");
  els.prefAutoLearn = document.getElementById("pref-auto-learn");
  els.prefAutoAddLearning = document.getElementById("pref-auto-add-learning");
  els.prefAutoTranslate = document.getElementById("pref-auto-translate");
  els.prefAutoTranslateRow = document.getElementById("pref-auto-translate-row");
  els.prefOfflineTranslator = document.getElementById("pref-offline-translator");
  els.prefTranslationProvider = document.getElementById("pref-translation-provider");
  els.prefTranslationLanguageSettings = document.getElementById("pref-translation-language-settings");
  els.prefTranslationSourceLanguage = document.getElementById("pref-translation-source-language");
  els.prefTranslationTargetLanguage = document.getElementById("pref-translation-target-language");
  els.prefDeepLApiKey = document.getElementById("pref-deepl-api-key");
  els.prefDeepLApiKeyRow = document.getElementById("pref-deepl-key-row");
  els.prefLmStudioEndpoint = document.getElementById("pref-lmstudio-endpoint");
  els.prefLmStudioEndpointRow = document.getElementById("pref-lmstudio-endpoint-row");
  els.prefLmStudioModel = document.getElementById("pref-lmstudio-model");
  els.prefLmStudioModelRow = document.getElementById("pref-lmstudio-model-row");
  els.prefArgosAsDict = document.getElementById("pref-argos-as-dict");
  els.prefArgosAsDictRow = document.getElementById("pref-argos-as-dict-row");
  els.argosDownloadDialog = byId("argos-download-dialog");
  els.argosDownloadConfirm = document.getElementById("argos-download-confirm");
  els.argosDownloadCancel = document.getElementById("argos-download-cancel");
  els.argosLanguagesList = document.getElementById("argos-languages-list");
  els.prefDictionaryUrl = document.getElementById("pref-dictionary-url");
  els.prefDictionaryMode = document.getElementById("pref-dictionary-mode");
  els.prefCardStats = document.getElementById("pref-card-stats");
  els.prefCardStatsMode = document.getElementById("pref-card-stats-mode");
  els.prefCardStatsModeRow = document.getElementById("pref-card-stats-mode-row");
  els.prefCovers = document.getElementById("pref-covers");
  els.ocrGpuStatus = document.getElementById("ocr-gpu-status");
  els.prefTextAlign = document.getElementById("pref-text-align");
  els.prefMaxWidth = document.getElementById("pref-max-width");
  els.prefReaderFocusMode = document.getElementById("pref-reader-focus-mode");
  els.prefReaderWordPanelVisible = document.getElementById("pref-reader-word-panel-visible");
  els.prefSelectedWordPanelItems = document.getElementById("pref-selected-word-panel-items");
  els.prefTtsRate = document.getElementById("pref-tts-rate");
  els.prefAutoTtsOnWordFocus = document.getElementById("pref-auto-tts-on-word-focus");
  els.prefTtsWordHighlight = document.getElementById("pref-tts-word-highlight");
  els.prefStatusSoundsEnabled = document.getElementById("pref-status-sounds-enabled");
  els.prefStatusSoundVolume = document.getElementById("pref-status-sound-volume");
  els.prefStatusSoundVolumeLabel = document.getElementById("pref-status-sound-volume-label");
  els.prefUseEdgeTts = document.getElementById("pref-use-edge-tts");

  els.storageSummary = document.getElementById("storage-summary");
  els.dataDirectory = document.getElementById("data-directory");
  els.syncDirectory = document.getElementById("sync-directory");
  els.syncStatus = document.getElementById("sync-status");
  els.syncHealth = document.getElementById("sync-health");
  els.syncthingStatus = document.getElementById("syncthing-status");
  els.syncthingPeers = document.getElementById("syncthing-peers");
  els.syncthingStart = document.getElementById("syncthing-start");
  els.syncthingStop = document.getElementById("syncthing-stop");
  els.syncthingPair = document.getElementById("syncthing-pair");
  els.syncthingShowQR = document.getElementById("syncthing-show-qr");
  els.syncthingQRDialog = document.getElementById("syncthing-qr-dialog");
  els.syncthingQRContainer = document.getElementById("syncthing-qr-container");
  els.syncthingQRDeviceID = document.getElementById("syncthing-qr-device-id");
  els.syncthingQRClose = document.getElementById("syncthing-qr-close");
  els.syncConflictsPanel = document.getElementById("sync-conflicts-panel");
  els.syncConflictsList = document.getElementById("sync-conflicts-list");
  els.recoveryStatusPanel = document.getElementById("recovery-status-panel");
  els.recoveryStatusList = document.getElementById("recovery-status-list");
  els.chooseDataDirectory = document.getElementById("choose-data-directory");
  els.prepareSyncDirectory = document.getElementById("prepare-sync-directory");
  els.chooseSyncDirectory = document.getElementById("choose-sync-directory");
  els.forceSync = document.getElementById("force-sync");

  els.discoverForm = byId("discover-form");
  els.discoverQuery = byId("discover-query");
  els.discoverSource = byId("discover-source");
  els.discoverSort = byId("discover-sort");
  els.discoverLevel = byId("discover-level");
  els.discoverResults = document.getElementById("discover-results");
  els.discoverPagination = document.getElementById("discover-pagination");
  els.discoverToolbar = document.getElementById("discover-toolbar");
  els.discoverStatus = document.getElementById("discover-status");
  els.discoverSelectAll = byId("discover-select-all");
  els.discoverClear = document.getElementById("discover-clear");
  els.discoverAddSelected = document.getElementById("discover-add-selected");
  els.userBooksList = document.getElementById("user-books-list");
  
  els.editBookDialog = byId("edit-book-dialog");
  els.editBookTitle = byId("edit-book-title");
  els.editBookAuthor = byId("edit-book-author");
  els.editBookTags = byId("edit-book-tags");
  els.editBookLevel = byId("edit-book-level");
  els.editBookCoverPreview = document.getElementById("edit-book-cover-preview");
  els.editBookCoverImg = byId("edit-book-cover-img");
  els.editBookCoverClear = document.getElementById("edit-book-cover-clear");
  els.editBookCover = byId("edit-book-cover");
  els.editBookText = byId("edit-book-text");
  els.editBookCancel = byId("edit-book-cancel");
  els.editBookSave = byId("edit-book-save");

  els.toast = document.getElementById("toast");
  els.toastMessage = document.getElementById("toast-message");
}
