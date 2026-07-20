// App constants. Data only, no logic.
export const STORAGE_KEY = "wordHunterStateV2";
export const UI_STORAGE_KEY = `${STORAGE_KEY}:ui`;
export const STATE_SCHEMA_VERSION = 2;

export type VocabStatus = "new" | "learning" | "known" | "ignored";

export const STATUS_ORDER: VocabStatus[] = ["new", "learning", "known", "ignored"];

export const SELECTED_WORD_PANEL_ITEM_IDS: readonly WhSelectedWordPanelItemId[] = [
  "status",
  "article",
  "dictionary",
  "speech",
  "youglish",
  "remove",
  "suggestion",
  "translation",
  "note",
  "image",
  "context",
  "copy",
  "edit"
];

export const DEFAULT_SELECTED_WORD_PANEL_ITEMS: readonly WhSelectedWordPanelItem[] = [
  { id: "status", visible: true },
  { id: "article", visible: false },
  { id: "dictionary", visible: true },
  { id: "speech", visible: true },
  { id: "youglish", visible: true },
  { id: "remove", visible: true },
  { id: "suggestion", visible: true },
  { id: "translation", visible: true },
  { id: "note", visible: false },
  { id: "image", visible: false },
  { id: "context", visible: true },
  { id: "copy", visible: false },
  { id: "edit", visible: true }
];

export const FONT_STACKS: Record<string, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Segoe UI", Tahoma, Arial, sans-serif',
  mono: '"JetBrains Mono", "Consolas", monospace'
};

export const LINE_HEIGHTS: Record<string, number> = {
  compact: 1.5,
  normal: 1.82,
  loose: 2.1
};

export const UI_SCALE = {
  MIN: 80,
  MAX: 150,
  STEP: 5,
  DEFAULT: 100
};

export const APP_LOCALES = ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"];
export const OTHER_PROFILE_ID = "other";
export const LEARNING_LANGUAGES = ["en", "de", "es", "it", "fr", "pl", "uk", "ru", "ja", "zh", "la", "grc", OTHER_PROFILE_ID];
export const TRANSLATOR_LANGUAGES = ["de", "en", "es", "fr", "it", "ja", "pl", "ru", "uk", "zh", "la", "grc"];
export const OFFLINE_TRANSLATOR_LANGUAGES = ["en", "pl", "de", "es", "fr", "it", "uk", "ru", "ja", "zh"];

export const BOOKS_INDEX_URL = "books/index.json";
export const GUTENDEX_URL = "https://gutendex.com/books/";
