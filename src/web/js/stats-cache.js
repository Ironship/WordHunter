import { normalizeWord, resolveTokenizerAlgorithm, tokenizeText } from "./tokenizer_v2.js";

const CACHE_STORAGE_KEY = "wordhunter:library-text-stats:v1";
const MAX_CACHE_ENTRIES = 80;

let cache = loadCache();
let saveTimer = null;

function loadCache() {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCache() {
  if (typeof localStorage === "undefined") return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      pruneCache();
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      const entries = Object.entries(cache).sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0));
      cache = Object.fromEntries(entries.slice(0, Math.floor(MAX_CACHE_ENTRIES / 2)));
      try {
        localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
      } catch {
        // Cache is an optimization; failure should never affect app behavior.
      }
    }
  }, 250);
}

function pruneCache() {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  cache = Object.fromEntries(
    entries
      .sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0))
      .slice(0, MAX_CACHE_ENTRIES)
  );
}

function sampleText(value) {
  const text = String(value || "");
  if (text.length <= 4096) return text;
  const middle = Math.max(0, Math.floor(text.length / 2) - 1024);
  return `${text.slice(0, 1536)}|${text.slice(middle, middle + 2048)}|${text.slice(-1536)}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function textSignature(book, text, lang, algorithm) {
  const mode = resolveTokenizerAlgorithm(algorithm);
  return [
    "v1",
    book?.id || "",
    lang || "",
    mode,
    book?.updatedAt || "",
    book?.createdAt || "",
    book?.textUrl || "",
    book?.localPath || "",
    String(text?.length || 0),
    hashString(sampleText(text))
  ].join("|");
}

function cacheKey(bookId, lang, algorithm) {
  return `${bookId || ""}|${lang || ""}|${resolveTokenizerAlgorithm(algorithm)}`;
}

function buildUniqueWords(text, lang, algorithm) {
  return Array.from(new Set(
    tokenizeText(text, lang, algorithm)
      .filter((part) => part.type === "word")
      .map((part) => normalizeWord(part.value))
      .filter(Boolean)
  ));
}

function statsFromWords(words, vocab) {
  const stats = { unique: words.length, known: 0, learning: 0, ignored: 0, new: 0 };
  for (const word of words) {
    const status = vocab?.[word]?.status || "new";
    stats[status] = (stats[status] || 0) + 1;
  }
  return stats;
}

export function getCachedTextStats(book, text, vocab, lang = "en", algorithm = "modern") {
  if (!text) return { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };

  const key = cacheKey(book?.id, lang, algorithm);
  const signature = textSignature(book, text, lang, algorithm);
  let entry = cache[key];

  if (!entry || entry.signature !== signature || !Array.isArray(entry.words)) {
    entry = {
      signature,
      words: buildUniqueWords(text, lang, algorithm),
      lastUsed: Date.now()
    };
    cache[key] = entry;
    persistCache();
  } else {
    entry.lastUsed = Date.now();
  }

  return statsFromWords(entry.words, vocab);
}

export function invalidateBookStats(bookId) {
  if (!bookId) return;
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(`${bookId}|`)) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) persistCache();
}

export function invalidateAllTextStats() {
  cache = {};
  persistCache();
}
