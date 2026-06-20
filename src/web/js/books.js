// Book catalog: fetches the built-in database from books/index.json and texts (local or remote).
import { BOOKS_INDEX_URL } from "./constants.js";
import { state } from "./state.js";
import { invalidateBookId } from "./vocab-index-client.js";
import { cleanGutenbergText } from "./tokenizer_v2.js";
import { t } from "./i18n.js";

let catalog = [];
export const bookTexts = new Map();
let bookTextsLoadingPromise = null;
const textLoadingById = new Map();

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
  
  bookTextsLoadingPromise = Promise.all(books.map((book) => 
    loadBookText(book).catch((error) => {
      console.warn(`Failed to load ${book.localPath || book.textUrl}:`, error);
    })
  )).finally(() => {
    bookTextsLoadingPromise = null;
  });
  
  return bookTextsLoadingPromise;
}

export async function loadBookText(book) {
  if (bookTexts.has(book.id)) return bookTexts.get(book.id);
  if (textLoadingById.has(book.id)) return textLoadingById.get(book.id);

  const promise = loadBookTextUncached(book).finally(() => {
    textLoadingById.delete(book.id);
  });
  textLoadingById.set(book.id, promise);
  return promise;
}

async function loadBookTextUncached(book) {
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
      bookTexts.set(book.id, text);
      return text;
    } catch (err) {
      lastError = err;
    }
    }
    throw lastError || new Error(t("toast.noTextSource"));
    }

async function loadCustomTextContent(text) {
  if (!text?.id) return "";
  if (bookTexts.has(text.id)) return bookTexts.get(text.id);
  if (text.text) {
    bookTexts.set(text.id, text.text);
    return text.text;
  }
  if (!window.__qtBridge) return "";
  if (textLoadingById.has(text.id)) return textLoadingById.get(text.id);

  const promise = fetch(`/__book/text?id=${encodeURIComponent(text.id)}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      const value = data.text || "";
      bookTexts.set(text.id, value);
      return value;
    })
    .finally(() => {
      textLoadingById.delete(text.id);
    });
  textLoadingById.set(text.id, promise);
  return promise;
}

export function loadAllCustomTextContents() {
  return Promise.all((state.customTexts || []).map((text) => loadCustomTextContent(text).catch((error) => {
    console.warn(`Failed to load custom text ${text.id}:`, error);
  })));
}

export function clearBookTextCache(id) {
  bookTexts.delete(id);
  textLoadingById.delete(id);
  invalidateBookId(id);
}
