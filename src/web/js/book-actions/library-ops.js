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
import {
  archiveBookId,
  clearCurrentBookSelectionIfMatches,
  forgetArchivedBook,
  hideBuiltInBookId,
  moveCustomTextToProfile,
  moveUserBookToProfile,
  removeUserBookFromActiveProfile
} from "./profile-library.js";

export function archiveBook(id) {
  if (!id) return;
  archiveBookId(id);
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

  if (isCustom) {
    const moved = moveCustomTextToProfile(id, targetLang);
    if (!moved) return;
    const { textObj, newId } = moved;
    invalidateBookId(id);
    invalidateBookId(newId);

    if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
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
    const bookObj = moveUserBookToProfile(id, targetLang);
    if (!bookObj) return;
    if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
    clearLastReadTextId(id);
  }

  saveState();
  render();
  showToast(t("toast.bookMoved"));
}

export function removeUserBook(id) {
  const bookObj = removeUserBookFromActiveProfile(id);
  if (!bookObj) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.userBookRemoved"));
}

export function hideBuiltInBook(id) {
  if (!hideBuiltInBookId(id)) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.bookHidden"));
}
