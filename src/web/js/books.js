// Book catalog: fetches the built-in database from books/index.json and texts (local or remote).
import { BOOKS_INDEX_URL } from "./constants.js";
import { registerBridgeSnapshotHandler, state } from "./state.js";
import { clearVocabIndexCache, invalidateBookId } from "./vocab-index-client.js";
import { cleanGutenbergText } from "./tokenizer_v2.js";
import { t } from "./i18n.js";

let catalog = [];
export const bookTexts = new Map();
let bookTextsLoadingPromise = null;
let allTextCacheGeneration = 0;
const textLoadingById = new Map();
const textCacheGenerationById = new Map();
const staleBookTextIds = new Set();
const TEXT_LOAD_CONCURRENCY = 2;
const CUSTOM_TEXT_LOAD_CONCURRENCY = 2;

export async function loadBooksCatalog() {
  try {
    const response = await fetch(BOOKS_INDEX_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    catalog = Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn("Failed to load book catalog:", error);
    catalog = [];
  }
  return catalog;
}

export function getAllBooks() {
  const hidden = new Set(state.hiddenBuiltInBooks || []);
  const currentLang = state.preferences?.learningLanguage || "en";
  return [
    ...catalog.filter((book) => !hidden.has(book.id) && book.lang === currentLang),
    ...(state.userBooks || [])
  ];
}

export function findBookById(id) {
  return getAllBooks().find((book) => book.id === id);
}

export function loadAllBookTexts() {
  // If a load is already in progress, return that promise
  if (bookTextsLoadingPromise) return bookTextsLoadingPromise;
  
  const books = getAllBooks();
  if (!books.length) {
    return Promise.resolve();
  }
  
  const batchGeneration = allTextCacheGeneration;
  let nextBook = 0;
  const loadNext = async () => {
    while (batchGeneration === allTextCacheGeneration && nextBook < books.length) {
      const book = books[nextBook++];
      await loadBookText(book).catch((error) => {
        console.warn(`Failed to load ${book.localPath || book.textUrl}:`, error);
      });
    }
  };
  // ponytail: two fetches keep startup memory bounded; every book still gets its complete text.
  const loading = Promise.all(
    Array.from({ length: Math.min(TEXT_LOAD_CONCURRENCY, books.length) }, loadNext)
  );
  const tracked = loading.finally(() => {
    if (bookTextsLoadingPromise === tracked) bookTextsLoadingPromise = null;
  });
  bookTextsLoadingPromise = tracked;
  
  return bookTextsLoadingPromise;
}

export async function loadBookText(book) {
  if (bookTexts.has(book.id) && !staleBookTextIds.has(book.id)) return bookTexts.get(book.id);
  if (textLoadingById.has(book.id)) return textLoadingById.get(book.id);

  const generation = textCacheGenerationById.get(book.id) || 0;
  const promise = loadBookTextUncached(book, generation).finally(() => {
    if (textLoadingById.get(book.id) === promise) textLoadingById.delete(book.id);
  });
  textLoadingById.set(book.id, promise);
  return promise;
}

async function loadBookTextUncached(book, generation) {
  const sources = [];
  if (book.localPath) sources.push(book.localPath);
  if (book.textUrl) sources.push(book.textUrl);
  let lastError = null;
  for (const url of sources) {
    try {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      let text = (await response.text()).trim();
      if (/\*\*\* (START|END) OF (THE|THIS) PROJECT GUTENBERG/i.test(text)) {
        text = cleanGutenbergText(text);
      }
      if (text.length < 200) throw new Error(`Text too short (${url})`);
      if ((textCacheGenerationById.get(book.id) || 0) === generation) {
        bookTexts.set(book.id, text);
        staleBookTextIds.delete(book.id);
      }
      return text;
    } catch (err) {
      lastError = err;
    }
    }
    throw lastError || new Error(t("toast.noTextSource"));
    }

export async function loadCustomTextContent(text) {
  if (!text?.id) return "";
  if (bookTexts.has(text.id) && !staleBookTextIds.has(text.id)) return bookTexts.get(text.id);
  if (textLoadingById.has(text.id)) return textLoadingById.get(text.id);
  if (text.text) {
    bookTexts.set(text.id, text.text);
    staleBookTextIds.delete(text.id);
    return text.text;
  }
  if (!window.__qtBridge) return "";
  return fetchCustomTextContent(text);
}

function fetchCustomTextContent(text) {
  const generation = (textCacheGenerationById.get(text.id) || 0) + 1;
  textCacheGenerationById.set(text.id, generation);
  staleBookTextIds.add(text.id);
  const promise = fetch(`/__book/text?id=${encodeURIComponent(text.id)}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      const value = data.text || "";
      if ((textCacheGenerationById.get(text.id) || 0) === generation) {
        bookTexts.set(text.id, value);
        staleBookTextIds.delete(text.id);
      }
      return value;
    })
    .finally(() => {
      if (textLoadingById.get(text.id) === promise) textLoadingById.delete(text.id);
    });
  textLoadingById.set(text.id, promise);
  return promise;
}

export function loadAllCustomTextContents() {
  const texts = state.customTexts || [];
  const batchGeneration = allTextCacheGeneration;
  let nextText = 0;
  const loadNext = async () => {
    while (batchGeneration === allTextCacheGeneration && nextText < texts.length) {
      const text = texts[nextText++];
      await loadCustomTextContent(text).catch((error) => {
        console.warn(`Failed to load custom text ${text.id}:`, error);
      });
    }
  };
  return Promise.all(
    Array.from({ length: Math.min(CUSTOM_TEXT_LOAD_CONCURRENCY, texts.length) }, loadNext)
  );
}

export async function hydrateActiveLibraryTexts() {
  const language = state.preferences?.learningLanguage;
  await Promise.all([loadAllBookTexts(), loadAllCustomTextContents()]);
  if (state.preferences?.learningLanguage !== language) return false;
  // A previous profile can still own the shared built-in batch promise.
  await Promise.all([loadAllBookTexts(), loadAllCustomTextContents()]);
  return state.preferences?.learningLanguage === language;
}

export function clearBookTextCache(id) {
  textCacheGenerationById.set(id, (textCacheGenerationById.get(id) || 0) + 1);
  bookTexts.delete(id);
  textLoadingById.delete(id);
  staleBookTextIds.delete(id);
  invalidateBookId(id);
}

function markBookTextCacheStale(id) {
  textCacheGenerationById.set(id, (textCacheGenerationById.get(id) || 0) + 1);
  textLoadingById.delete(id);
  staleBookTextIds.add(id);
}

export function clearAllBookTextCaches() {
  allTextCacheGeneration += 1;
  bookTextsLoadingPromise = null;
  const ids = new Set([...bookTexts.keys(), ...textLoadingById.keys(), ...textCacheGenerationById.keys()]);
  for (const id of ids) textCacheGenerationById.set(id, (textCacheGenerationById.get(id) || 0) + 1);
  bookTexts.clear();
  textLoadingById.clear();
  staleBookTextIds.clear();
  clearVocabIndexCache();
}

export function isBookTextCacheStale(id) {
  return staleBookTextIds.has(id);
}

registerBridgeSnapshotHandler(({ previousTextIds, currentTextIds }) => {
  for (const id of previousTextIds || []) {
    if (!currentTextIds?.has(id)) clearBookTextCache(id);
  }
  if (!window.__qtBridge) return;

  const texts = state.customTexts || [];
  for (const text of texts) {
    if (text?.id) markBookTextCacheStale(text.id);
  }

  loadAllCustomTextContents()
    .then(async () => {
      if (state.currentView === "library") {
        const { renderLibrary } = await import("./views/library.js");
        renderLibrary();
        return;
      }
      const activeId = state.currentTextId;
      if (state.currentView !== "reader" || !activeId || !currentTextIds?.has(activeId)) return;
      const { renderReader } = await import("./reader/renderer.js");
      renderReader();
    })
    .catch((error) => console.warn("Failed to refresh synchronized custom texts:", error));
});
