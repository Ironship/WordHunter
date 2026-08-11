export {};

declare global {
  type WhRecord = Record<string, any>;

  type WhVocabStatus = "new" | "learning" | "known" | "ignored";

  type WhSelectedWordPanelItemId =
    | "status"
    | "article"
    | "dictionary"
    | "speech"
    | "youglish"
    | "suggestion"
    | "translation"
    | "note"
    | "image"
    | "context"
    | "ai"
    | "copy"
    | "edit"
    | "remove";

  interface WhSelectedWordPanelItem {
    id: WhSelectedWordPanelItemId;
    visible: boolean;
  }

  interface WhVocabEntry extends WhRecord {
    word?: string;
    status: WhVocabStatus;
    article?: string;
    translation?: string;
    translationSource?: string;
    translationAutoRejected?: boolean;
    note?: string;
    examples?: string[];
    imageUrl?: string;
    interval: number;
    repetition: number;
    efactor: number;
    stability: number;
    difficulty: number;
    srsAlgorithm: "sm2" | "fsrs";
    nextDate: string;
    addedAt?: string;
    learningStartedAt?: string;
    knownAt?: string;
    lastReviewedAt?: string;
    updatedAt?: string;
    statusUpdatedAt?: string;
    lastUsed?: number;
  }

  type WhVocabulary = Record<string, WhVocabEntry>;

  type WhReaderBookmarkColor = "amber" | "red" | "green" | "blue" | "purple";

  interface WhReaderBookmark {
    id: string;
    label: string;
    color?: WhReaderBookmarkColor;
    page: number;
    scrollTop: number;
    wordIndex: number | null;
    anchorWord?: string;
    anchorBefore?: string;
    anchorAfter?: string;
    anchorOffset?: number;
    wordAlgorithm?: "classic" | "modern";
    createdAt: string;
  }

  interface WhText extends WhRecord {
    id: string;
    title?: string;
    author?: string;
    text?: string;
    lang?: string;
    level?: string;
    tags?: string[];
    cover?: string;
    source?: string;
    pdfOcrPages?: WhRecord[];
  }

  interface WhPreferences extends WhRecord {
    theme: WhThemeName;
    locale: string;
    languageOnboardingDone: boolean;
    readerFont: string;
    readerFontSize: number;
    readerLineHeight: string;
    highlightTokens: boolean;
    hideKnownIgnored: boolean;
    inTextReview: boolean;
    inTextReviewCompletedGuesses: number;
    dynamicLearningColors: boolean;
    learningColors: string[];
    autoLearnOnClick: boolean;
    autoAddLearningOnly: boolean;
    showCardStats: boolean;
    cardStatsMode: string;
    showCovers: boolean;
    learningLanguage: string;
    dictionaryUrl: string;
    dictionaryMode: string;
    readerTextAlign: string;
    readerMaxWidth: string;
    readerFocusMode: boolean;
    readerWordPanelVisible: boolean;
    selectedWordPanelItems: WhSelectedWordPanelItem[];
    touchControls: boolean;
    readerSidebarWidth: number;
    librarySidebarWidth: number;
    ttsRate: string;
    autoTtsOnWordFocus: boolean;
    autoTtsOnFlashcardOpen: boolean;
    ttsWordHighlight: boolean;
    ttsWordHighlightDefaultVersion: number;
    statusSoundsEnabled: boolean;
    statusSoundVolume: number;
    reviewReverse: boolean;
    srsAlgorithm: "sm2" | "fsrs";
    removalBehavior: string;
    useEdgeTts: boolean;
    autoTranslateWords: boolean;
    translationProvider: string;
    translationSourceLanguage: string;
    translationTargetLanguage: string;
    deeplApiKey: string;
    lmStudioEndpoint: string;
    lmStudioModel: string;
    aiExplanationsEnabled: boolean;
    aiExplanationEndpoint: string;
    aiExplanationApiKey: string;
    aiExplanationModel: string;
    aiExplanationEffort: string;
    aiExplanationAutoTrigger: boolean;
    ankiExportStatuses: WhVocabStatus[];
    wordDetectionAlgorithm: string;
    uiScale: number;
    lastReadTextIds: Record<string, string>;
    skippedVersion: string;
    disableUpdateCheck: boolean;
    wordsPerPage: number;
    argosAsDict: boolean;
    offlineTranslator: boolean;
    colorNew: string;
    colorLearning: string;
    colorKnown: string;
    colorIgnored: string;
    reviewGraphType: string;
    graphRange: string;
    readerBookmarks: Record<string, WhReaderBookmark[]>;
  }


  interface WhProfilePreferences extends WhRecord {
    dictionaryUrl?: string;
    dictionaryMode?: string;
    translationSourceLanguage?: string;
    translationTargetLanguage?: string;
  }

  interface WhProfile extends WhRecord {
    vocab: WhVocabulary;
    customTexts: WhText[];
    userBooks: WhText[];
    hiddenBuiltInBooks: string[];
    archivedBookIds: string[];
    preferences?: WhProfilePreferences;
  }

  interface WhStateFilters extends WhRecord {
    libraryQuery: string;
    libraryLevel: string;
    librarySort: string;
    librarySortReverse: boolean;
    libraryArchive: string;
    vocabQuery: string;
    vocabStatuses: WhVocabStatus[];
    vocabTextId: string;
  }

  interface WhDiscoverState extends WhRecord {
    query: string;
    source: string;
    sort: string;
    level: string;
    page: number;
  }

  interface WhRecoveryStatus extends WhRecord {
    schemaVersion: number;
    skippedRecordCount: number;
    skippedRecords: WhRecord[];
    corruptConflictCount: number;
    corruptConflicts: WhRecord[];
    pendingSaveJournal: boolean;
    pendingSaveJournalTemp: boolean;
    pendingWipeJournal: boolean;
    quarantinedSaveJournal: boolean;
  }

  interface WhAppState extends WhRecord {
    schemaVersion: number;
    currentView: string;
    currentTextId: string | null;
    selectedWord: string | null;
    selectedWordIndex: number | null;
    readerSelectionRange: WhRecord | null;
    customTexts: WhText[];
    userBooks: WhText[];
    hiddenBuiltInBooks: string[];
    archivedBookIds: string[];
    vocab: WhVocabulary;
    profiles: Record<string, WhProfile>;
    reviewIndex: number;
    readerFontSize: number;
    readerPdfZoom: number;
    readerPdfViewMode: string;
    readerPage: number;
    readerPages: Record<string, number>;
    readerScrolls: Record<string, any>;
    readerScrollsPerPage: Record<string, number>;
    dataDirectory: string;
    recoveryStatus: WhRecoveryStatus | null;
    filters: WhStateFilters;
    discover: WhDiscoverState;
    preferences: WhPreferences;
    _raw?: WhAppState;
  }

  type WhThemeName =
    | "familiar"
    | "alternative-familiar"
    | "classic-auto"
    | "classic-light"
    | "classic-dark";

  type WhThemeFamily = "familiar" | "alternative-familiar" | "classic";
  type WhThemeMode = "light" | "dark";

  interface WhBridgeSnapshot {
    schemaVersion: number;
    dataDir?: string;
    recoveryStatus?: WhRecoveryStatus | null;
    prefs?: WhRecord;
    vocab?: Record<string, WhProfile | WhRecord>;
    texts?: WhText[];
    hiddenBooks?: string[];
    uiState?: WhRecord;
    [key: string]: unknown;
  }

  interface WhBridgeSaveResult extends WhRecord {
    ok?: boolean;
    snapshot?: WhBridgeSnapshot;
    recoveryStatus?: WhRecoveryStatus | null;
  }

  interface WhBridgeSnapshotChange {
    textIds: Set<string>;
    preserveActiveReader: boolean;
    previousTextIds: Set<string>;
    currentTextIds: Set<string>;
  }

  interface WhSaveStateInput {
    profiles?: Record<string, WhProfile>;
    customTexts?: WhText[];
    preferences?: WhPreferences;
    discover?: WhDiscoverState;
    hiddenBuiltInBooks?: string[];
    [key: string]: any;
  }

  interface WhSavePayload {
    schemaVersion: number;
    texts: WhText[];
    prefs: WhRecord;
    hiddenBooks: string[];
    vocab: Record<string, WhRecord>;
  }

  interface WhDeltaSavePayload {
    schemaVersion: number;
    delta: true;
    fullKeys: string[];
    records: {
      schemaVersion: number;
      texts: WhText[];
      prefs: WhRecord;
      hiddenBooks: string[];
      vocab: Record<string, WhRecord>;
    };
  }

  interface WhStoredTextInput extends WhRecord {
    id: string;
    text: string;
  }

  interface WhAndroidBridge {
    openUrl(url: string): boolean;
    saveExport?(data: string, filename: string, mime: string, requestId: string): boolean;
    saveExportFile?(path: string, filename: string, mime: string, requestId: string): boolean;
    chooseImportPackage?(requestId: string): boolean;
    speak?(text: string, language: string, rate: number, requestId: string): boolean;
    stopTts?(): void;
    beginPdfRender?(sessionId: string, data: string): string;
    renderPdfPage?(sessionId: string, pageIndex: number, width: number): string;
    endPdfRender?(sessionId: string): void;
  }

interface WhDomCache {
    navItems?: HTMLElement[];
    views?: HTMLElement[];

    levelFilter?: HTMLSelectElement | null;
    textSelect?: HTMLSelectElement | null;
    readerFontSizeSlider?: HTMLInputElement | null;
    translatorFrom?: HTMLSelectElement | null;
    translatorTo?: HTMLSelectElement | null;
    translatorSwap?: HTMLButtonElement | null;
    translatorSource?: HTMLTextAreaElement | null;
    translatorResult?: HTMLTextAreaElement | null;
    vocabSearch?: HTMLInputElement | null;
    vocabTextFilter?: HTMLSelectElement | null;
    vocabStatusFilter?: HTMLFieldSetElement | null;
    vocabStatusFilters?: HTMLInputElement[];
    vocabTableBody?: HTMLTableSectionElement | null;
    ankiExportStatusFilters?: HTMLInputElement[];
    prefLocales?: HTMLSelectElement[];
    prefLearningLanguages?: HTMLSelectElement[];
    prefLocale?: HTMLSelectElement | null;
    prefLearningLanguage?: HTMLSelectElement | null;
    prefTheme?: HTMLSelectElement | null;
    prefLearningColors?: HTMLInputElement[];
    discoverForm?: HTMLFormElement | null;
    discoverQuery?: HTMLInputElement | null;
    discoverSource?: HTMLSelectElement | null;
    discoverSort?: HTMLSelectElement | null;
    discoverLevel?: HTMLSelectElement | null;
    discoverSelectAll?: HTMLButtonElement | null;
    chooseDataDirectory?: HTMLElement | null;
    clearLibrary?: HTMLElement | null;
    clearState?: HTMLElement | null;
    clearWords?: HTMLElement | null;
    dataDirectory?: HTMLElement | null;
    discoverAddSelected?: HTMLButtonElement | null;
    discoverClear?: HTMLElement | null;
    discoverPagination?: HTMLElement | null;
    discoverResults?: HTMLElement | null;
    discoverStatus?: HTMLElement | null;
    discoverToolbar?: HTMLElement | null;
    exportAnkiTsv?: HTMLElement | null;
    exportVocabAnki?: HTMLElement | null;
    exportVocabTxt?: HTMLElement | null;
    importAnkiTsv?: HTMLElement | null;

    ocrGpuStatus?: HTMLElement | null;
    overallCount?: HTMLElement | null;
    pageTitle?: HTMLElement | null;
    pillKnown?: HTMLElement | null;
    pillLearning?: HTMLElement | null;
    pillNew?: HTMLElement | null;
    pocketNavigationToggle?: HTMLElement | null;
    prefAiApiKey?: HTMLInputElement | null;
    prefAiApiKeyRow?: HTMLElement | null;
    prefAiAutoTrigger?: HTMLInputElement | null;
    prefAiAutoTriggerRow?: HTMLElement | null;
    prefAiEffort?: HTMLSelectElement | null;
    prefAiEffortRow?: HTMLElement | null;
    prefAiEndpoint?: HTMLInputElement | null;
    prefAiEndpointRow?: HTMLElement | null;
    prefAiExplanations?: HTMLInputElement | null;
    prefAiModel?: HTMLInputElement | null;
    prefAiModelRow?: HTMLElement | null;
    prefArgosAsDict?: HTMLInputElement | null;
    prefArgosAsDictRow?: HTMLElement | null;
    prefAutoAddLearning?: HTMLInputElement | null;
    prefAutoLearn?: HTMLInputElement | null;
    prefAutoTranslate?: HTMLInputElement | null;
    prefAutoTranslateRow?: HTMLElement | null;
    prefAutoTtsOnFlashcardOpen?: HTMLInputElement | null;
    prefAutoTtsOnWordFocus?: HTMLInputElement | null;
    prefCardStats?: HTMLInputElement | null;
    prefCardStatsMode?: HTMLSelectElement | null;
    prefCardStatsModeRow?: HTMLElement | null;
    prefColorIgnored?: HTMLInputElement | null;
    prefColorKnown?: HTMLInputElement | null;
    prefColorLearning?: HTMLInputElement | null;
    prefColorNew?: HTMLInputElement | null;
    prefCovers?: HTMLInputElement | null;
    prefDeepLApiKey?: HTMLInputElement | null;
    prefDeepLApiKeyRow?: HTMLElement | null;
    prefDictionaryMode?: HTMLSelectElement | null;
    prefDictionaryUrl?: HTMLInputElement | null;
    prefYouglishMode?: HTMLSelectElement | null;
    prefDynamicLearningColors?: HTMLInputElement | null;
    prefFont?: HTMLSelectElement | null;
    prefFontSize?: HTMLInputElement | null;
    prefFontSizeLabel?: HTMLElement | null;
    prefHideKnown?: HTMLInputElement | null;
    prefHighlight?: HTMLInputElement | null;
    prefInTextReview?: HTMLInputElement | null;
    prefLearningColorsRow?: HTMLElement | null;
    prefLineHeight?: HTMLSelectElement | null;
    prefLmStudioEndpoint?: HTMLInputElement | null;
    prefLmStudioEndpointRow?: HTMLElement | null;
    prefLmStudioModel?: HTMLInputElement | null;
    prefLmStudioModelRow?: HTMLElement | null;
    prefMaxWidth?: HTMLSelectElement | null;
    prefOfflineTranslator?: HTMLInputElement | null;
    prefReaderFocusMode?: HTMLInputElement | null;
    prefReaderWordPanelVisible?: HTMLInputElement | null;
    prefRemovalBehavior?: HTMLSelectElement | null;
    prefReviewGraphType?: HTMLSelectElement | null;
    prefSelectedWordPanelItems?: HTMLElement | null;
    prefSrsAlgorithm?: HTMLSelectElement | null;
    prefStatusSoundVolume?: HTMLInputElement | null;
    prefStatusSoundVolumeLabel?: HTMLElement | null;
    prefStatusSoundsEnabled?: HTMLInputElement | null;
    prefTextAlign?: HTMLSelectElement | null;
    prefTouchControls?: HTMLInputElement | null;
    prefTranslationLanguageSettings?: HTMLElement | null;
    prefTranslationProvider?: HTMLSelectElement | null;
    prefTranslationSourceLanguage?: HTMLInputElement | null;
    prefTranslationTargetLanguage?: HTMLInputElement | null;
    prefTtsRate?: HTMLSelectElement | null;
    prefTtsWordHighlight?: HTMLInputElement | null;
    prefUiScale?: HTMLInputElement | null;
    prefUiScaleLabel?: HTMLElement | null;
    prefUseEdgeTts?: HTMLInputElement | null;
    prefWordAlgorithm?: HTMLSelectElement | null;
    prefWordsPerPage?: HTMLSelectElement | null;
    progressBar?: HTMLElement | null;
    progressBarLearning?: HTMLElement | null;
    readerFindClose?: HTMLElement | null;
    readerFindToggle?: HTMLElement | null;
    readerFindCount?: HTMLElement | null;
    readerFindInput?: HTMLInputElement | null;
    readerFindNext?: HTMLElement | null;
    readerFindPrev?: HTMLElement | null;
    readerFontSizeValue?: HTMLElement | null;
    readerHeading?: HTMLElement | null;
    readerHighlightToggle?: HTMLElement | null;
    readerNextWord?: HTMLElement | null;
    readerPreviousWord?: HTMLElement | null;
    readerSidebarResizer?: HTMLElement | null;
    readerSource?: HTMLElement | null;
    readerText?: HTMLElement | null;
    readerWordPanelToggle?: HTMLElement | null;
    recoveryStatusList?: HTMLElement | null;
    recoveryStatusPanel?: HTMLElement | null;
    resetPrefs?: HTMLElement | null;
    reviewCard?: HTMLElement | null;
    reviewChart?: HTMLElement | null;
    reviewReverseLabel?: HTMLElement | null;
    reviewReverseToggle?: HTMLElement | null;
    reviewUpcoming?: HTMLElement | null;
    storageSummary?: HTMLElement | null;
    themeToggle?: HTMLElement | null;
    trackingSummary?: HTMLElement | null;
    translatorAiExplain?: HTMLElement | null;
    translatorAiResult?: HTMLElement | null;
    translatorNavItem?: HTMLElement | null;
    translatorProgress?: HTMLElement | null;
    translatorStatus?: HTMLElement | null;
    uniqueSummary?: HTMLElement | null;
    userBooksList?: HTMLElement | null;
    wordPanel?: HTMLElement | null;
}

  interface Window {
    __qtBridge?: boolean;
    WH_TOKEN?: string;
    WH_IMAGE_OCR_AVAILABLE?: boolean;
    __bridgeState?: unknown;
    __bridgeStatePromise?: Promise<WhBridgeSnapshot>;
    WordHunterAndroid?: WhAndroidBridge;
    flushPendingSave?: () => void;
    buildPendingDeltaEnvelope?: () => { payload: string; session: string; sequence: number };
    hasPendingChanges?: () => boolean;
    flushAllPendingFrontendState?: () => Promise<void>;
    requestWordHunterClose?: () => void;
    flushWordFieldSave?: () => void;
    wordHunterBootRejectionHandler?: (event: PromiseRejectionEvent) => void;
    wordHunterBootTimeout?: number;
    lastActiveToken?: HTMLElement | null;
  }
}
