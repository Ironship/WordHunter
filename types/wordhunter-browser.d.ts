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
    knownAt?: string;
    lastReviewedAt?: string;
    updatedAt?: string;
    lastUsed?: number;
  }

  type WhVocabulary = Record<string, WhVocabEntry>;

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

  interface WhSyncConflict extends WhRecord {
    id: string;
    key: string;
    reason: string;
    timestamp: string;
    kept: WhRecord;
    conflict: WhRecord;
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
    syncDirectory: string;
    syncHealth: WhRecord | null;
    cloudSyncStatus: WhRecord | null;
    syncthingStatus: WhRecord | null;
    syncConflictCount: number;
    syncConflicts: WhSyncConflict[];
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

  interface WhResolvedTheme {
    theme: WhThemeName;
    family: WhThemeFamily;
    mode: WhThemeMode;
    color: string;
  }

  interface WhBridgeSnapshot {
    schemaVersion: number;
    dataDir?: string;
    syncDir?: string;
    syncHealth?: WhRecord | null;
    cloudSyncStatus?: WhRecord | null;
    syncthingStatus?: WhRecord | null;
    syncConflictCount?: number;
    syncConflicts?: WhSyncConflict[];
    recoveryStatus?: WhRecoveryStatus | null;
    prefs?: WhRecord;
    vocab?: Record<string, WhProfile | WhRecord>;
    texts?: WhText[];
    hiddenBooks?: string[];
    [key: string]: unknown;
  }

  interface WhBridgeSaveResult extends WhRecord {
    ok?: boolean;
    snapshot?: WhBridgeSnapshot;
    recoveryStatus?: WhRecoveryStatus | null;
    syncHealth?: WhRecord | null;
    syncConflictCount?: number;
    syncConflicts?: WhSyncConflict[];
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

  interface WhStoredTextInput extends WhRecord {
    id: string;
    text: string;
  }

  interface WhAndroidBridge {
    openUrl(url: string): boolean;
    saveExport?(data: string, filename: string, mime: string, requestId: string): boolean;
    speak?(text: string, language: string, rate: number, requestId: string): boolean;
    stopTts?(): void;
    getSyncFolderLabel?(): string;
    chooseSyncFolder?(token: string, requestId: string): boolean;
    forceSyncFolder?(token: string, requestId: string): boolean;
    beginPdfRender?(sessionId: string, data: string): string;
    renderPdfPage?(sessionId: string, pageIndex: number, width: number): string;
    endPdfRender?(sessionId: string): void;
  }

  interface WhDomCache {
    [key: string]: any;
    navItems?: HTMLElement[];
    views?: HTMLElement[];
    librarySearch?: HTMLInputElement | null;
    levelFilter?: HTMLSelectElement | null;
    librarySort?: HTMLSelectElement | null;
    libraryArchiveFilter?: HTMLSelectElement | null;
    librarySortReverse?: HTMLButtonElement | null;
    importForm?: HTMLFormElement | null;
    importYoutubeUrl?: HTMLInputElement | null;
    importYoutubeLoad?: HTMLButtonElement | null;
    importYoutubeTrack?: HTMLSelectElement | null;
    importTitle?: HTMLInputElement | null;
    importAuthor?: HTMLInputElement | null;
    importTags?: HTMLInputElement | null;
    importLevel?: HTMLSelectElement | null;
    importText?: HTMLTextAreaElement | null;
    importFile?: HTMLInputElement | null;
    importCover?: HTMLInputElement | null;
    importCoverImg?: HTMLImageElement | null;
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
    languageOnboardingDialog?: HTMLDialogElement | null;
    argosDownloadDialog?: HTMLDialogElement | null;
    discoverForm?: HTMLFormElement | null;
    discoverQuery?: HTMLInputElement | null;
    discoverSource?: HTMLSelectElement | null;
    discoverSort?: HTMLSelectElement | null;
    discoverLevel?: HTMLSelectElement | null;
    discoverSelectAll?: HTMLButtonElement | null;
    editBookDialog?: HTMLDialogElement | null;
    editBookTitle?: HTMLInputElement | null;
    editBookAuthor?: HTMLInputElement | null;
    editBookTags?: HTMLInputElement | null;
    editBookLevel?: HTMLSelectElement | null;
    editBookCoverImg?: HTMLImageElement | null;
    editBookCover?: HTMLInputElement | null;
    editBookText?: HTMLTextAreaElement | null;
    editBookCancel?: HTMLButtonElement | null;
    editBookSave?: HTMLButtonElement | null;
  }

  interface Window {
    __qtBridge?: boolean;
    WH_TOKEN?: string;
    __bridgeState?: unknown;
    WordHunterAndroid?: WhAndroidBridge;
    flushPendingSave?: () => void;
    flushAllPendingFrontendState?: () => Promise<void>;
    flushWordFieldSave?: () => void;
    wordHunterBootRejectionHandler?: (event: PromiseRejectionEvent) => void;
    lastActiveToken?: HTMLElement | null;
  }
}
