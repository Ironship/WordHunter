/**
 * Book text sources: Gutenberg full-text fetch and user book add.
 */
import { state, saveState, setLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { getNavigationEpoch, setView } from "../render.js";
import { setReaderLoading, clearReaderLoading, renderReader } from "../reader/renderer.js";
import { bookTexts, findBookById, loadBookText } from "../books.js";
import type { LibraryBook } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { cleanGutenbergText } from "../tokenizer_v2.js";
import { cleanCatalogTitle } from "../utils.js";
import { t as translate } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { importCustomText } from "./custom-text.js";
import { addUserBookToActiveProfile, findCustomText, hasUserBook } from "./profile-library.js";

const t = translate as (key: string, vars?: WhRecord) => string;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringProperty(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export async function loadFullGutenbergText(book: LibraryBook): Promise<void> {
  if (!book.gutenbergId) {
    const { openBook } = await import("../book-actions.js");
    await openBook(book.id);
    return;
  }
  const cachedId = `gutenberg-full-${book.gutenbergId}`;
  const cached = findCustomText(cachedId);
  if (cached && cached.text && cached.text.length >= 500) {
    state.currentTextId = cached.id;
    setLastReadTextId(cached.id);
    state.selectedWord = null;
    setView("reader");
    saveState();
    showToast(t("toast.loadedLocal", { title: cached.title }));
    return;
  }
  showToast(t("toast.fetchingTxt", { title: book.title }));
  setView("reader");
  const loadingNavigationEpoch = getNavigationEpoch();
  setReaderLoading({ title: book.title || "...", author: book.author, source: book.source });
  try {
    if (book.localPath) {
      try {
        const localResponse = await fetch(book.localPath, { cache: "force-cache" });
        if (localResponse.ok) {
          const localText = (await localResponse.text()).trim();
          if (localText.length >= 500) {
            if (loadingNavigationEpoch !== getNavigationEpoch()) return;
            bookTexts.set(book.id, localText);
            invalidateBookId(book.id);
            state.currentTextId = book.id;
            setLastReadTextId(book.id);
            state.selectedWord = null;
            setView("reader");
            saveState();
            showToast(t("toast.loadedLocal", { title: book.title }));
            return;
          }
        }
      } catch (localError) {
        console.warn("No local copy:", localError);
      }
    }
    const rawText = await fetchTextWithFallback(book.textUrl);
    const cleanText = cleanGutenbergText(rawText);
    if (cleanText.length < 500) throw new Error(t("toast.textTooShort"));
    const importedId = await importCustomText(`${book.title} ${t("bookActions.fullTextSuffix")}`, cleanText, {
      id: `gutenberg-full-${book.gutenbergId}`,
      author: book.author,
      source: t("reader.sourceGutenbergTxt"),
      level: book.level,
      sourceUrl: book.pageUrl,
      textUrl: book.textUrl
    }, false);
    if (importedId && loadingNavigationEpoch === getNavigationEpoch()) {
      const { openBook } = await import("../book-actions.js");
      await openBook(importedId);
    }
  } catch (error) {
    console.warn(error);
    showToast(t("toast.fetchTxtFailed"));
  } finally {
    clearReaderLoading();
    if (state.currentView === "reader" && loadingNavigationEpoch === getNavigationEpoch()) renderReader();
  }
}

async function fetchTextWithFallback(url: string): Promise<string> {
  const attempts = [
    `/__proxy?url=${encodeURIComponent(url)}`,
    url
  ];
  let lastError: unknown;
  for (const target of attempts) {
    try {
      const response = await fetch(target, { cache: "force-cache" });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status} (${target})`); continue; }
      const text = await response.text();
      if (text && text.length >= 500) return text;
      lastError = new Error(`Empty text (${target})`);
    } catch (err: unknown) {
      lastError = err;
    }
  }
  throw lastError || new Error(t("toast.fetchTextFailed"));
}

export async function addUserBook(result: unknown, { silent }: { silent?: boolean } = {}): Promise<boolean> {
  const book = asRecord(result);
  if (!book) throw new TypeError("Discover result must be an object");
  const source = stringProperty(book, "source");
  const isGutenberg = !source || source === "gutenberg";
  const title = cleanCatalogTitle(book.title) || t("library.untitled");

  if (!isGutenberg) return addMediaWikiBook(book, title);

  const gutenbergId = String(book.id);
  const id = `user-${gutenbergId}`;
  const exists = hasUserBook(id) || findBookById(id);
  if (exists) return false;

  const formats = asRecord(book.formats) || {};
  const textFormat = formats["text/plain; charset=utf-8"] || formats["text/plain"];
  const imageFormat = formats["image/jpeg"];
  const textUrl = typeof textFormat === "string" ? textFormat : `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`;
  const coverUrl = typeof imageFormat === "string" ? imageFormat : `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`;
  const authors = Array.isArray(book.authors) ? book.authors : [];
  const author = authors.map((value: unknown) => {
    const authorRecord = asRecord(value);
    return authorRecord ? stringProperty(authorRecord, "name") : "";
  }).join(", ") || t("reader.sourceGutenberg");
  const firstAuthor = asRecord(authors[0]);
  const summaries = Array.isArray(book.summaries) ? book.summaries : [];
  const summary = typeof summaries[0] === "string" ? summaries[0] : "";

  const newBook = addUserBookToActiveProfile({
    id, gutenbergId, title, author, level: "custom",
    year: firstAuthor?.birth_year ?? "", pages: t("reader.sourceGutenberg"),
    pageUrl: `https://www.gutenberg.org/ebooks/${gutenbergId}`, textUrl, coverUrl, coverPath: null,
    blurb: summary.slice(0, 240), sample: ""
  });
  saveState();
  if (!silent) showToast(t("toast.added", { title }));
  loadBookText(newBook).catch(() => {});
  renderLibrary();
  return true;
}

async function addMediaWikiBook(result: UnknownRecord, title: string): Promise<boolean> {
  const resultId = String(result.id);
  const exists = state.customTexts.some((book) => String(book.id) === resultId)
    || state.userBooks.some((book) => String(book.id) === resultId);
  if (exists) return false;

  showToast(t("toast.fetchingTxt", { title }));
  try {
    const languages = Array.isArray(result.languages) ? result.languages : [];
    const firstLanguage = typeof languages[0] === "string" ? languages[0] : "";
    const apiLang = stringProperty(result, "apiLang") || firstLanguage || "en";
    const domain = stringProperty(result, "domain");
    const mediaWikiId = String(result.mwId);
    const apiUrl = `https://${apiLang}.${domain}/w/api.php?action=query&prop=extracts&explaintext=1&pageids=${mediaWikiId}&format=json&origin=*`;
    const res = await fetch(apiUrl);
    const data: unknown = await res.json();
    const dataRecord = asRecord(data);
    const query = asRecord(dataRecord?.query);
    const pages = asRecord(query?.pages);
    const page = asRecord(pages?.[mediaWikiId]);
    const extract = page ? stringProperty(page, "extract") : "";
    if (!extract) throw new Error("No text found");

    const sourceName = mediaWikiSourceName(result.source);
    const sourceUrl = `https://${apiLang}.${domain}/?curid=${mediaWikiId}`;

    await importCustomText(title, extract, {
      id: resultId,
      author: sourceName,
      source: sourceName,
      sourceUrl,
      level: "custom",
      coverDataUrl: stringProperty(result, "coverDataUrl")
    }, false);

    const { renderDiscover } = await import("../views/discover.js");
    renderDiscover();
    return true;
  } catch (e) {
    console.warn(e);
    showToast(t("toast.fetchTxtFailed"));
    return false;
  }
}

function mediaWikiSourceName(source: unknown): string {
  if (source === "wikinews") return t("discover.sourceWikinews");
  if (source === "wikisource") return t("discover.sourceWikisource");
  return t("discover.sourceWikipedia");
}
