/**
 * Book text sources: Gutenberg full-text fetch and user book add.
 */
import { state, saveState, setLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { getNavigationEpoch, setView } from "../render.js";
import { setReaderLoading, clearReaderLoading, renderReader } from "../reader/renderer.js";
import { bookTexts, findBookById, loadBookText, loadCustomTextContent } from "../books.js";
import type { LibraryBook } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { cleanGutenbergText } from "../tokenizer_v2.js";
import { cleanCatalogTitle } from "../utils.js";
import { t as translate } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { importCustomText } from "./custom-text.js";
import { forgetUserBook } from "./library-ops.js";
import { addUserBookToActiveProfile, findCustomText, hasUserBook } from "./profile-library.js";
import { fetchDiscover } from "../discover/fetch-discover.js";
import {
  isMediaWikiArticleInLibrary,
  mediaWikiArticleTextUrl,
  mediaWikiArticleUrl,
  mediaWikiBookId,
  mediaWikiSourceName
} from "../discover/mediawiki.js";
import type { MediaWikiSource } from "../discover/mediawiki.js";

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
  if (isLegacyMediaWikiBook(book)) {
    // openBook replaces it with the article.
    const { openBook } = await import("../book-actions.js");
    await openBook(book.id);
    return;
  }
  if (!book.gutenbergId) {
    const { openBook } = await import("../book-actions.js");
    await openBook(book.id);
    return;
  }
  const cachedId = `gutenberg-full-${state.preferences.learningLanguage}-${book.gutenbergId}`;
  const legacyCachedId = `gutenberg-full-${book.gutenbergId}`;
  const cached = findCustomText(cachedId) || findCustomText(legacyCachedId);
  const cachedText = cached
    ? await loadCustomTextContent(cached).catch(() => "")
    : "";
  if (cached && cachedText.length >= 500) {
    bookTexts.set(cached.id, cachedText);
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
      id: cachedId,
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
      const { fetchWithTimeout } = await import("../request.js");
      const response = await fetchWithTimeout(target, { cache: "force-cache" }, 20_000);
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
  const title = cleanCatalogTitle(book.title) || t("library.untitled");
  const source = stringProperty(book, "source");
  if (source === "wikipedia" || source === "wikinews") return addMediaWikiArticle(book, source, title, silent);

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

// Wikipedia and Wikinews results carry a MediaWiki page id, not a Gutenberg
// one: the article's plain text comes from the wiki's own API and is stored as
// a custom text of the active profile.
async function addMediaWikiArticle(result: UnknownRecord, source: MediaWikiSource, title: string, silent = false): Promise<boolean> {
  const apiLang = stringProperty(result, "apiLang") || "en";
  const pageId = String(result.mwId ?? "");
  if (!/^\d+$/.test(pageId)) throw new TypeError("MediaWiki result has no page id");
  if (isMediaWikiArticleInLibrary({ id: String(result.id), source, apiLang, mwId: pageId })) return false;
  const importedId = await importMediaWikiArticle({
    source, apiLang, pageId, title, coverDataUrl: stringProperty(result, "coverDataUrl"), silent
  });
  // 1.1.0 and 1.1.1 added these results as Gutenberg books that never
  // loaded; the working copy replaces such an entry.
  if (importedId && forgetUserBook(`user-${String(result.id)}`)) {
    await saveState();
    renderLibrary();
  }
  return Boolean(importedId);
}

interface MediaWikiArticle {
  source: MediaWikiSource;
  apiLang: string;
  pageId: string;
  title: string;
  coverDataUrl?: string;
  silent?: boolean;
}

async function importMediaWikiArticle({ source, apiLang, pageId, title, coverDataUrl = "", silent = false }: MediaWikiArticle): Promise<string | null> {
  // The article joins the profile that was active when it was added.
  const learningLanguage = state.preferences.learningLanguage;
  if (!silent) showToast(t("toast.fetchingTxt", { title }));
  try {
    const response = await fetchDiscover(mediaWikiArticleTextUrl(source, apiLang, pageId), null);
    const data = asRecord(await response.json());
    const pages = asRecord(asRecord(data?.query)?.pages);
    const page = asRecord(pages?.[pageId]);
    const text = page ? stringProperty(page, "extract").trim() : "";
    if (!text) throw new Error(`No text for ${source} page ${pageId}`);
    if (state.preferences.learningLanguage !== learningLanguage) return null;
    const sourceName = mediaWikiSourceName(source);
    return await importCustomText(title, text, {
      id: mediaWikiBookId(source, apiLang, pageId, learningLanguage),
      author: sourceName,
      source: sourceName,
      sourceUrl: mediaWikiArticleUrl(source, apiLang, pageId),
      level: "custom",
      coverDataUrl
    }, false, { silent });
  } catch (error) {
    console.warn(error);
    showToast(t("toast.fetchTextFailed"), "error");
    return null;
  }
}

/** The article behind a Discover wiki result that 1.1.0/1.1.1 saved as a Gutenberg book. */
function legacyMediaWikiArticle(book: LibraryBook): Omit<MediaWikiArticle, "title"> | null {
  const match = /^mw-(?:[a-z0-9-]*?-)?(wikipedia|wikinews)-([a-z0-9-]+)-(\d+)$/.exec(String(book.gutenbergId ?? ""));
  if (!match || !String(book.id).startsWith("user-mw-")) return null;
  return { source: match[1] as MediaWikiSource, apiLang: match[2], pageId: match[3] };
}

export function isLegacyMediaWikiBook(book: LibraryBook): boolean {
  return legacyMediaWikiArticle(book) !== null;
}

/** Imports the article behind such a book and drops the book; returns the article's text id. */
export async function replaceLegacyMediaWikiBook(book: LibraryBook): Promise<string | null> {
  const article = legacyMediaWikiArticle(book);
  if (!article) return null;
  const existing = (state.customTexts || []).find((text) => text.sourceUrl === mediaWikiArticleUrl(article.source, article.apiLang, article.pageId));
  const importedId = existing?.id || await importMediaWikiArticle({ ...article, title: book.title || t("library.untitled") });
  if (!importedId) return null;
  if (forgetUserBook(book.id)) await saveState();
  return importedId;
}
