/**
 * Book text sources: Gutenberg full-text fetch, fallback chain, user book add.
 */
import { state, saveState, setLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { setView, render } from "../render.js";
import { setReaderLoading, clearReaderLoading, renderReader } from "../views/reader.js";
import { bookTexts, findBookById, loadBookText } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { cleanGutenbergText } from "../tokenizer_v2.js";
import { t } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { importCustomText } from "./custom-text.js";

export async function loadFullGutenbergText(book) {
  const cachedId = `gutenberg-full-${book.gutenbergId}`;
  const cached = state.customTexts.find((item) => item.id === cachedId);
  if (cached && cached.text && cached.text.length >= 500) {
    state.currentTextId = cached.id;
    setLastReadTextId(cached.id);
    state.selectedWord = null;
    setView("reader");
    saveState();
    render();
    showToast(t("toast.loadedLocal", { title: cached.title }));
    return;
  }
  showToast(t("toast.fetchingTxt", { title: book.title }));
  setView("reader");
  setReaderLoading(book);
  try {
    if (book.localPath) {
      try {
        const localResponse = await fetch(book.localPath, { cache: "force-cache" });
        if (localResponse.ok) {
          const localText = (await localResponse.text()).trim();
          if (localText.length >= 500) {
            bookTexts.set(book.id, localText);
            invalidateBookId(book.id);
            state.currentTextId = book.id;
            setLastReadTextId(book.id);
            state.selectedWord = null;
            setView("reader");
            saveState();
            render();
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
    await importCustomText(`${book.title} ${t("bookActions.fullTextSuffix")}`, cleanText, {
      id: `gutenberg-full-${book.gutenbergId}`,
      author: book.author,
      source: t("reader.sourceGutenbergTxt"),
      level: book.level,
      sourceUrl: book.pageUrl,
      textUrl: book.textUrl
    });
  } catch (error) {
    console.warn(error);
    showToast(t("toast.fetchTxtFailed"));
  } finally {
    clearReaderLoading();
    renderReader();
  }
}

async function fetchTextWithFallback(url) {
  const attempts = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://r.jina.ai/${url}`
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

  if (!isGutenberg) {
    const exists = state.customTexts.some(b => String(b.id) === String(result.id)) || state.userBooks.some(b => String(b.id) === String(result.id));
    if (exists) return false;

    showToast(t("toast.fetchingTxt", { title: result.title }));
    try {
      const apiUrl = `https://${result.languages[0]}.${result.domain}/w/api.php?action=query&prop=extracts&explaintext=1&pageids=${result.mwId}&format=json&origin=*`;
      const res = await fetch(apiUrl);
      const data = await res.json();
      const page = data.query?.pages?.[result.mwId];
      if (!page || !page.extract) throw new Error("No text found");

      const cleanText = page.extract;
      const sourceName = result.source === "wikipedia" ? t("discover.sourceWikipedia") : t("discover.sourceWikinews");
      const sourceUrl = `https://${result.languages[0]}.${result.domain}/?curid=${result.mwId}`;

      await importCustomText(result.title, cleanText, {
        id: result.id,
        author: sourceName,
        source: sourceName,
        sourceUrl: sourceUrl,
        level: "custom",
        coverDataUrl: result.coverDataUrl || ""
      }, false);

      // We don't add to userBooks because importCustomText already added to customTexts.

      // Need to re-render discover to update button state
      const { renderDiscover } = await import("../views/discover.js");
      renderDiscover();

    } catch (e) {
      showToast(t("toast.fetchTxtFailed"));
      return false;
    }
    return true;
  }

  const gutenbergId = String(result.id);
  const id = `user-${gutenbergId}`;
  const exists = state.userBooks.some((b) => b.id === id) || findBookById(id);
  if (exists) return false;

  const formats = result.formats || {};
  const textUrl = formats["text/plain; charset=utf-8"] || formats["text/plain"] || `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.txt`;
  const coverUrl = formats["image/jpeg"] || `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`;
  const author = (result.authors || []).map((a) => a.name).join(", ") || t("reader.sourceGutenberg");

  state.userBooks.push({
    id, gutenbergId, title: result.title || t("library.untitled"), author, level: "custom",
    year: result.authors?.[0]?.birth_year ?? "", pages: t("reader.sourceGutenberg"),
    pageUrl: `https://www.gutenberg.org/ebooks/${gutenbergId}`, textUrl, coverUrl, coverPath: null,
    blurb: (result.summaries?.[0] || "").slice(0, 240), sample: ""
  });
  saveState();
  if (!silent) showToast(t("toast.added", { title: result.title }));
  const newBook = state.userBooks[state.userBooks.length - 1];
  loadBookText(newBook).catch(() => {});
  renderLibrary();
  return true;
}
