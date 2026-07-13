/**
 * Library operations: archive/unarchive, hide, remove, move-to-profile.
 */
import { state, saveState, clearLastReadTextId } from "../state.js";
import { showToast as displayToast } from "../toast.js";
import { render, ensureCurrentText } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { bookTexts, clearBookTextCache } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { t as translate } from "../i18n.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "../bridge-commit.js";
import { deleteStoredText, upsertStoredText } from "../store-bridge.js";
import {
  archiveBookId,
  clearCurrentBookSelectionIfMatches,
  forgetArchivedBook,
  hideBuiltInBookId,
  moveCustomTextToProfile,
  moveUserBookToProfile,
  planCustomTextMove,
  removeUserBookFromActiveProfile
} from "./profile-library.js";

const t = translate as (key: string, vars?: WhRecord) => string;
const showToast = displayToast as (message: string, kind?: string) => void;

export function archiveBook(id: string): void {
  if (!id) return;
  archiveBookId(id);
  saveState();
  renderLibrary();
  showToast(t("toast.bookArchived"));
}

export function unarchiveBook(id: string): void {
  if (!id) return;
  forgetArchivedBook(id);
  saveState();
  renderLibrary();
  showToast(t("toast.bookUnarchived"));
}

async function loadCustomTextBodyForMove(id: string, textObj: WhText): Promise<string> {
  const cached = bookTexts.get(id);
  if (typeof cached === "string" && cached.trim()) return cached;
  if (typeof textObj?.text === "string" && textObj.text.trim()) return textObj.text;
  if (!window.__qtBridge) return "";
  const response = await fetch(`/__book/text?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`/__book/text HTTP ${response.status}`);
  const data: unknown = await response.json();
  const body = typeof data === "object"
    && data !== null
    && "text" in data
    && typeof data.text === "string"
    ? data.text
    : "";
  if (!body.trim()) throw new Error("custom text body is empty");
  return body;
}

export async function moveBookToProfile(id: string, targetLang: string, isCustom: boolean): Promise<boolean> {
  const currentLang = state.preferences.learningLanguage;
  if (currentLang === targetLang) return false;

  if (isCustom) {
    const planned = planCustomTextMove(id, targetLang);
    if (!planned) return false;
    let textBody = "";
    try {
      textBody = await loadCustomTextBodyForMove(id, planned.textObj);
      if (window.__qtBridge) {
        await upsertStoredText({ ...planned.textObj, text: textBody });
        await deleteStoredText(id);
      }
    } catch (error) {
      console.warn("move custom text backend write failed", error);
      showToast(t("toast.syncUnavailable"), "error");
      return false;
    }
    const moved = moveCustomTextToProfile(id, targetLang);
    if (!moved) return false;
    const { textObj, newId } = moved;
    if (!window.__qtBridge) textObj.text = textBody;
    if (textBody) bookTexts.set(newId, textBody);
    bookTexts.delete(id);
    invalidateBookId(id);
    invalidateBookId(newId);

    if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
    clearLastReadTextId(id);
  } else {
    const bookObj = moveUserBookToProfile(id, targetLang);
    if (!bookObj) return false;
    if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
    clearLastReadTextId(id);
  }

  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("move book profile save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("move book recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return false;
  }
  render();
  showToast(t("toast.bookMoved"));
  return true;
}

export function removeUserBook(id: string): void {
  const bookObj = removeUserBookFromActiveProfile(id);
  if (!bookObj) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.userBookRemoved"));
}

export function hideBuiltInBook(id: string): void {
  if (!hideBuiltInBookId(id)) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
  saveState();
  render();
  showToast(t("toast.bookHidden"));
}
