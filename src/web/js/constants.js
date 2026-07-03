// App constants. Data only, no logic.
export const STORAGE_KEY = "wordHunterStateV1";
export const STATE_SCHEMA_VERSION = 2;

export const STATUS_ORDER = ["new", "learning", "known", "ignored"];

export const FONT_STACKS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Segoe UI", Tahoma, Arial, sans-serif',
  mono: '"JetBrains Mono", "Consolas", monospace'
};

export const LINE_HEIGHTS = {
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
export const LEARNING_LANGUAGES = ["en", "de", "es", "it", "fr", "pl", "uk", "ru", "ja", "zh", "la", "grc"];
export const TRANSLATOR_LANGUAGES = ["de", "en", "es", "fr", "it", "ja", "pl", "ru", "uk", "zh", "la", "grc"];
export const OFFLINE_TRANSLATOR_LANGUAGES = ["en", "pl", "de", "es", "fr", "it", "uk", "ru", "ja", "zh"];

export const BOOKS_INDEX_URL = "books/index.json";
export const GUTENDEX_URL = "https://gutendex.com/books/";
