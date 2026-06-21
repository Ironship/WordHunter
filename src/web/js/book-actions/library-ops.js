/**
 * Library operations: archive/unarchive, hide, remove, move-to-profile.
 */
import { state, saveState, clearLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { render, ensureCurrentText } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { bookTexts, clearBookTextCache } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { t } from "../i18n.js";

export function ensureArchivedBookIds() {
  if (!Array.isArray(state.archivedBookIds)) state.archivedBookIds = [];
  const lang = state.preferences.learningLanguage;
  if (state.profiles?.[lang]) {
    state.profiles[lang].archivedBookIds = state.archivedBookIds;
  }
}

export function forgetArchivedBook(id) {
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
    invalidateBookId(id);
    invalidateBookId(newId);

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
