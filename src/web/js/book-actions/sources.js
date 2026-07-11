/**
 * Book text sources: Gutenberg full-text fetch and user book add.
 */
import { state, saveState, setLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { getNavigationEpoch, setView } from "../render.js";
import { setReaderLoading, clearReaderLoading, renderReader } from "../reader/renderer.js";
import { bookTexts, findBookById, loadBookText } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { cleanGutenbergText } from "../tokenizer_v2.js";
import { cleanCatalogTitle } from "../utils.js";
import { t } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { importCustomText } from "./custom-text.js";
import { addUserBookToActiveProfile, findCustomText, hasUserBook } from "./profile-library.js";

export async function loadFullGutenbergText(book) {
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
  setReaderLoading(book);
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

async function fetchTextWithFallback(url) {
  const attempts = [
    `/__proxy?url=${encodeURIComponent(url)}`,
    url
  ];
  let lastError;
  for (const target of attempts) {
    try {
      const response = await fetch(target, { cache: "force-cache" });
      if (!response.ok) { lastError = new Error(`HTTP ${response.status} (${target})`); continue; }
      const text = await response.text();
      if (text && text.length >= 500) return text;
      lastError = new Error(`Empty text (${target})`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(t("toast.fetchTextFailed"));
}

export async function addUserBook(result, { silent } = {}) {
  const isGutenberg = !result.source || result.source === "gutenberg";
  const title = cleanCatalogTitle(result.title) || t("library.untitled");

  if (!isGutenberg) return addMediaWikiBook(result, title);

  const gutenbergId = String(result.id);
  const id = `user-${gutenbergId}`;
  const exists = hasUserBook(id) || findBookById(id);
  if (exists) return false;

  const formats = result.formats || {};
  const textUrl = formats["text/plain; charset=utf-8"] || formats["text/plain"] || `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`;
  const coverUrl = formats["image/jpeg"] || `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`;
  const author = (result.authors || []).map((a) => a.name).join(", ") || t("reader.sourceGutenberg");

  const newBook = addUserBookToActiveProfile({
    id, gutenbergId, title, author, level: "custom",
    year: result.authors?.[0]?.birth_year ?? "", pages: t("reader.sourceGutenberg"),
    pageUrl: `https://www.gutenberg.org/ebooks/${gutenbergId}`, textUrl, coverUrl, coverPath: null,
    blurb: (result.summaries?.[0] || "").slice(0, 240), sample: ""
  });
  saveState();
  if (!silent) showToast(t("toast.added", { title }));
  loadBookText(newBook).catch(() => {});
  renderLibrary();
  return true;
}

async function addMediaWikiBook(result, title) {
  const exists = state.customTexts.some(b => String(b.id) === String(result.id)) || state.userBooks.some(b => String(b.id) === String(result.id));
  if (exists) return false;

  showToast(t("toast.fetchingTxt", { title }));
  try {
    const apiLang = result.apiLang || result.languages?.[0] || "en";
    const apiUrl = `https://${apiLang}.${result.domain}/w/api.php?action=query&prop=extracts&explaintext=1&pageids=${result.mwId}&format=json&origin=*`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    const page = data.query?.pages?.[result.mwId];
    if (!page || !page.extract) throw new Error("No text found");

    const sourceName = mediaWikiSourceName(result.source);
    const sourceUrl = `https://${apiLang}.${result.domain}/?curid=${result.mwId}`;

    await importCustomText(title, page.extract, {
      id: result.id,
      author: sourceName,
      source: sourceName,
      sourceUrl,
      level: "custom",
      coverDataUrl: result.coverDataUrl || ""
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

function mediaWikiSourceName(source) {
  if (source === "wikinews") return t("discover.sourceWikinews");
  if (source === "wikisource") return t("discover.sourceWikisource");
  return t("discover.sourceWikipedia");
}
