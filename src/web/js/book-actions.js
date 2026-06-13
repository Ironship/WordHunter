import { state, saveState, getLastReadTextId, setLastReadTextId, clearLastReadTextId } from "./state.js";
import { showToast } from "./toast.js";
import { els } from "./dom.js";
import { render, setView, ensureCurrentText } from "./render.js";
import { renderLibrary } from "./views/library.js";
import { renderReader, setReaderLoading, clearReaderLoading, rememberReaderScrollPosition } from "./views/reader.js";
import { bookTexts, clearBookTextCache, loadBookText, findBookById } from "./books.js";
import { invalidateBookStats } from "./stats-cache.js";
import { cleanGutenbergText } from "./tokenizer_v2.js";
import { formatTagList, parseTagList } from "./utils.js";
import { t } from "./i18n.js";

export async function openBook(id) {
  rememberReaderScrollPosition();
  state.currentTextId = id;
  setLastReadTextId(id);
  const isCustom = state.customTexts.some(t => t.id === id);
  if (!bookTexts.has(id)) {
    const customText = state.customTexts.find(t => t.id === id);
    const catalogBook = findBookById(id);
    const book = customText || catalogBook;
    if (book) {
      try {
        setReaderLoading({ title: book.title || "..." });
        if (isCustom && window.__qtBridge) {
          const res = await fetch(`/__book/text?id=${encodeURIComponent(id)}`);
          const data = await res.json();
          bookTexts.set(id, data.text || "");
        } else if (isCustom && customText?.text) {
          bookTexts.set(id, customText.text);
        } else if (catalogBook) {
          await loadBookText(catalogBook);
        }
      } catch (e) {
        console.warn("fetch text failed", e);
      } finally {
        clearReaderLoading();
      }
    }
  }
  
  state.selectedWord = null;
  setView("reader");
  render();
}

function isReadableBookAvailable(id) {
  if (!id) return false;
  return state.customTexts.some(t => t.id === id) || !!findBookById(id);
}

export async function openLastReadBook() {
  const currentId = state.currentTextId;
  if (isReadableBookAvailable(currentId)) {
    await openBook(currentId);
    return true;
  }

  const lastId = getLastReadTextId();
  if (isReadableBookAvailable(lastId)) {
    await openBook(lastId);
    return true;
  }

  setView("reader");
  return false;
}

export async function importCustomText(title, text, meta = {}, openAfterImport = true) {
  const cleanTitle = title.trim();
  const cleanText = text.trim();
  if (!cleanTitle || !cleanText) return;

  const now = new Date().toISOString();
  const slug = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const id = meta.id || `${state.preferences.learningLanguage}-custom-${slug || Date.now()}`;
  const customText = {
    id: id,
    title: cleanTitle,
    lang: state.preferences.learningLanguage,
    author: (meta.author || "").trim(),
    source: meta.source || t("reader.localSource"),
    level: meta.level || "",
    blurb: (meta.blurb || "").trim(),
    tags: parseTagList(meta.tags),
    sourceUrl: meta.sourceUrl || "",
    textUrl: meta.textUrl || "",
    coverDataUrl: meta.coverDataUrl || "",
    createdAt: meta.createdAt || now,
    updatedAt: now
  };
  
  if (!window.__qtBridge) {
    customText.text = cleanText; // Save locally if no backend
  }
  
  bookTexts.set(id, cleanText);
  invalidateBookStats(id);

  const idx = state.customTexts.findIndex(item => String(item.id) === String(customText.id));
  if (idx !== -1) state.customTexts.splice(idx, 1);
  state.customTexts.push(customText);

  if (window.__qtBridge) {
    const payload = { ...customText, text: cleanText };
    try {
      await fetch("/__store/upsert_text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify(payload)
      });
    } catch(e) { console.warn("upsert_text failed", e); }
  }

  saveState();
  showToast(t("toast.textAdded"));
  if (openAfterImport) {
    await openBook(id);
  } else {
    renderLibrary();
  }
}

let editingBookId = null;
export let pendingEditCoverDataUrl = null;

export function setPendingEditCoverDataUrl(url) {
  pendingEditCoverDataUrl = url;
}

export async function openEditBookModal(id) {
  const customText = state.customTexts.find(t => t.id === id);
  const builtInBook = !customText ? findBookById(id) : null;
  if (!customText && !builtInBook) return;
  editingBookId = id;
  
  if (customText) {
    els.editBookTitle.value = customText.title || "";
    els.editBookAuthor.value = customText.author || "";
    if (els.editBookTags) els.editBookTags.value = formatTagList(customText.tags);
    if (els.editBookLevel) els.editBookLevel.value = customText.level || "";
  } else {
    els.editBookTitle.value = builtInBook.title || "";
    els.editBookAuthor.value = builtInBook.author || "";
    if (els.editBookTags) els.editBookTags.value = formatTagList(builtInBook.tags);
    if (els.editBookLevel) els.editBookLevel.value = builtInBook.level || "";
  }
  
  if (window.__qtBridge && !bookTexts.has(id)) {
    try {
      const res = await fetch(`/__book/text?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.text) bookTexts.set(id, data.text);
    } catch(e) { console.warn(e); }
  }
  els.editBookText.value = bookTexts.get(id) || (customText && customText.text) || "";
  
  const coverUrl = customText ? (customText.coverDataUrl || "") : (builtInBook ? (builtInBook.coverDataUrl || "") : "");
  pendingEditCoverDataUrl = coverUrl;
  if (pendingEditCoverDataUrl) {
    els.editBookCoverImg.src = pendingEditCoverDataUrl;
    els.editBookCoverPreview.hidden = false;
  } else {
    els.editBookCoverImg.src = "";
    els.editBookCoverPreview.hidden = true;
  }
  
  els.editBookDialog.showModal();
}

export async function saveEditedBook() {
  if (!editingBookId) return;
  const customText = state.customTexts.find(t => t.id === editingBookId);
  const builtInBook = !customText ? findBookById(editingBookId) : null;
  if (!customText && !builtInBook) return;
  
  const cleanTitle = els.editBookTitle.value.trim();
  const cleanText = els.editBookText.value.trim();
  if (!cleanTitle || !cleanText) {
    showToast(t("toast.emptyFields"));
    return;
  }
  
  if (customText) {
    customText.title = cleanTitle;
    customText.author = els.editBookAuthor.value.trim();
    customText.tags = parseTagList(els.editBookTags?.value);
    customText.coverDataUrl = pendingEditCoverDataUrl;
    customText.level = els.editBookLevel?.value || "";
    customText.updatedAt = new Date().toISOString();
  } else if (builtInBook) {
    builtInBook.tags = parseTagList(els.editBookTags?.value);
    builtInBook.level = els.editBookLevel?.value || "";
    builtInBook.updatedAt = new Date().toISOString();
  }
  
  bookTexts.set(editingBookId, cleanText);
  invalidateBookStats(editingBookId);
  
  if (window.__qtBridge) {
    const payload = customText
      ? { ...customText, text: cleanText }
      : { id: editingBookId, title: cleanTitle, author: els.editBookAuthor.value.trim(), tags: parseTagList(els.editBookTags?.value), text: cleanText, coverDataUrl: pendingEditCoverDataUrl, level: builtInBook.level || "B1", updatedAt: builtInBook.updatedAt };
    try {
      await fetch("/__store/upsert_text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify(payload)
      });
    } catch(e) { console.warn("upsert_text failed", e); }
  }
  
  saveState();
  renderLibrary();
  if (state.currentTextId === editingBookId) renderReader();
  showToast(t("toast.textSaved"));
  els.editBookDialog.close();
  editingBookId = null;
}

export async function pasteImageToEditBook(file) {
  if (!editingBookId) return;
  const ext = file.type.split("/")[1] || "png";
  const imgName = `img_${Date.now()}.${ext}`;
  
  const reader = new FileReader();
  reader.onload = async () => {
    const base64Data = reader.result;
    const textarea = els.editBookText;
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    const textToInsert = `\n[IMG:${imgName}]\n`;
    
    textarea.value = textarea.value.substring(0, startPos) + textToInsert + textarea.value.substring(endPos, textarea.value.length);
    textarea.selectionStart = startPos + textToInsert.length;
    textarea.selectionEnd = startPos + textToInsert.length;
    
    if (window.__qtBridge) {
      try {
        await fetch("/__book/image", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
          body: JSON.stringify({ book_id: editingBookId, img_name: imgName, base64_data: base64Data })
        });
      } catch(e) { console.warn("Image upload failed", e); }
    }
  };
  reader.readAsDataURL(file);
}

export function moveBookToProfile(id, targetLang, isCustom) {
  const currentLang = state.preferences.learningLanguage;
  if (currentLang === targetLang) return;
  
  if (!state.profiles[targetLang]) {
    state.profiles[targetLang] = { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  }

  if (isCustom) {
    const textIdx = state.customTexts.findIndex(t => t.id === id);
    if (textIdx === -1) return;
    const textObj = state.customTexts[textIdx];
    
    forgetArchivedBook(id);
    state.customTexts.splice(textIdx, 1);
    const newId = id.replace(/^[a-z]{2}-/, `${targetLang}-`);
    textObj.id = newId;
    textObj.updatedAt = new Date().toISOString();
    state.profiles[targetLang].customTexts.push(textObj);
    invalidateBookStats(id);
    invalidateBookStats(newId);
    
    if (state.currentTextId === id) {
      state.currentTextId = null;
      state.selectedWord = null;
      ensureCurrentText();
    }
    clearLastReadTextId(id);
    
    if (window.__qtBridge) {
      const textObjForSave = { ...textObj, text: bookTexts.get(newId) || bookTexts.get(id) || "" };
      fetch("/__store/upsert_text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify(textObjForSave)
      }).catch(e => console.warn("move_text upsert failed", e));
      
      fetch("/__store/delete_text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({ id: id })
      }).catch(e => console.warn("move_text delete failed", e));
    }
  } else {
    const bookIdx = state.userBooks.findIndex(b => b.id === id);
    if (bookIdx === -1) return;
    const bookObj = state.userBooks[bookIdx];
    forgetArchivedBook(id);
    state.userBooks.splice(bookIdx, 1);
    state.profiles[targetLang].userBooks.push(bookObj);
    if (state.currentTextId === id) {
      state.currentTextId = null;
      state.selectedWord = null;
      ensureCurrentText();
    }
    clearLastReadTextId(id);
  }
  
  saveState();
  render();
  showToast(t("toast.bookMoved"));
}

export function removeCustomText(id) {
  const idx = state.customTexts.findIndex(t => t.id === id);
  if (idx === -1) return;
  forgetArchivedBook(id);
  state.customTexts.splice(idx, 1);
  invalidateBookStats(id);
  if (state.currentTextId === id) {
    state.currentTextId = null;
    state.selectedWord = null;
    ensureCurrentText();
  }
  clearLastReadTextId(id);

  if (window.__qtBridge) {
    fetch("/__store/delete_text", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ id: id })
    }).catch(e => console.warn("delete_text failed", e));
  }

  saveState();
  render();
  showToast(t("toast.textRemoved"));
}

function ensureArchivedBookIds() {
  if (!Array.isArray(state.archivedBookIds)) state.archivedBookIds = [];
  const lang = state.preferences.learningLanguage;
  if (state.profiles?.[lang]) {
    state.profiles[lang].archivedBookIds = state.archivedBookIds;
  }
}

function forgetArchivedBook(id) {
  ensureArchivedBookIds();
  const idx = state.archivedBookIds.indexOf(id);
  if (idx !== -1) state.archivedBookIds.splice(idx, 1);
}

export function archiveBook(id) {
  if (!id) return;
  ensureArchivedBookIds();
  if (!state.archivedBookIds.includes(id)) state.archivedBookIds.push(id);
  saveState();
  renderLibrary();
  showToast(t("toast.bookArchived"));
}

export function unarchiveBook(id) {
  if (!id) return;
  forgetArchivedBook(id);
  saveState();
  renderLibrary();
  showToast(t("toast.bookUnarchived"));
}

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
            invalidateBookStats(book.id);
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
      const { renderDiscover } = await import("./views/discover.js");
      renderDiscover();
      
    } catch (e) {
      showToast(t("toast.fetchTxtFailed"));
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

export function removeUserBook(id) {
  const idx = state.userBooks.findIndex(b => b.id === id);
  if (idx === -1) return;
  forgetArchivedBook(id);
  state.userBooks.splice(idx, 1);
  clearBookTextCache(id);
  if (state.currentTextId === id) {
    state.currentTextId = null;
    state.selectedWord = null;
    ensureCurrentText();
  }
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.userBookRemoved"));
}

export function hideBuiltInBook(id) {
  if (!Array.isArray(state.hiddenBuiltInBooks)) {
    state.hiddenBuiltInBooks = [];
    const lang = state.preferences.learningLanguage;
    if (state.profiles && state.profiles[lang]) {
      state.profiles[lang].hiddenBuiltInBooks = state.hiddenBuiltInBooks;
    }
  }
  if (state.hiddenBuiltInBooks.includes(id)) return;
  forgetArchivedBook(id);
  state.hiddenBuiltInBooks.push(id);
  clearBookTextCache(id);
  if (state.currentTextId === id) {
    state.currentTextId = null;
    state.selectedWord = null;
    ensureCurrentText();
  }
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.bookHidden"));
}
