export {};

declare global {
  type WhRecord = Record<string, any>;

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
    dataDir?: unknown;
    syncDir?: unknown;
    syncHealth?: unknown;
    cloudSyncStatus?: unknown;
    syncthingStatus?: unknown;
    syncConflictCount?: unknown;
    syncConflicts?: unknown;
    recoveryStatus?: unknown;
    prefs?: unknown;
    vocab?: unknown;
    texts?: unknown;
    hiddenBooks?: unknown;
    [key: string]: unknown;
  }

  interface WhSaveStateInput {
    profiles?: Record<string, WhRecord>;
    customTexts?: WhRecord[];
    preferences?: WhRecord;
    discover?: WhRecord;
    hiddenBuiltInBooks?: string[];
    [key: string]: any;
  }

  interface WhSavePayload {
    schemaVersion: number;
    texts: WhRecord[];
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
  }

  interface Window {
    __qtBridge?: boolean;
    WH_TOKEN?: string;
    __bridgeState?: unknown;
    WordHunterAndroid?: WhAndroidBridge;
    flushPendingSave?: () => void;
    flushAllPendingFrontendState?: () => Promise<void>;
  }
}
