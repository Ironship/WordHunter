/**
 * Library operations: archive/unarchive, hide, remove, move-to-profile.
 */
import { state, saveState, clearLastReadTextId } from "../state.js";
import { showToast as displayToast } from "../toast.js";
import { render, ensureCurrentText } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { bookTexts, clearBookTextCache, loadCustomTextContent } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { t as translate } from "../i18n.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "../bridge-commit.js";
import { deleteStoredText, upsertStoredText } from "../store-bridge.js";
import {
  archiveBookId,
  clearCurrentBookSelectionIfMatches,
  forgetArchivedBook,
  forgetReaderPositionIfUnreferenced,
  gutenbergFullTextIds,
  hideBuiltInBookId,
  isCustomTextReferenced,
  moveCustomTextToProfile,
  moveUserBookToProfile,
  planCustomTextMove,
  removeCustomTextFromActiveProfile,
  removeUserBookFromActiveProfile
} from "./profile-library.js";

const t = translate as (key: string, vars?: WhRecord) => string;
const showToast = displayToast as (message: string, kind?: string) => void;

function cloneMoveUiState(): WhRecord {
  const keys = [
    "currentTextId",
    "selectedWord",
    "selectedWordIndex",
    "readerSelectionRange",
    "readerPage",
    "readerPages",
    "readerScrolls",
    "readerScrollsPerPage"
  ];
  const snapshot: WhRecord = {};
  for (const key of keys) {
    const value = state[key];
    snapshot[key] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  snapshot.lastReadTextIds = JSON.parse(JSON.stringify(state.preferences.lastReadTextIds || {}));
  return snapshot;
}

function restoreMoveUiState(snapshot: WhRecord): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "lastReadTextIds") continue;
    if (value === undefined) delete state[key];
    else state[key] = JSON.parse(JSON.stringify(value));
  }
  state.preferences.lastReadTextIds = JSON.parse(JSON.stringify(snapshot.lastReadTextIds || {}));
}

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
  const body = await loadCustomTextContent({ ...textObj, id });
  if (!body.trim()) throw new Error("custom text body is empty");
  return body;
}

export async function moveBookToProfile(id: string, targetLang: string, isCustom: boolean): Promise<boolean> {
  const currentLang = state.preferences.learningLanguage;
  if (currentLang === targetLang) return false;
  const previousUiState = cloneMoveUiState();
  let movedCustom: { oldId: string; newId: string; textBody: string } | null = null;

  if (isCustom) {
    const planned = planCustomTextMove(id, targetLang);
    if (!planned) return false;
    let textBody = "";
    try {
      textBody = await loadCustomTextBodyForMove(id, planned.textObj);
      if (window.__qtBridge) {
        await upsertStoredText({ ...planned.textObj, text: textBody });
      }
    } catch (error) {
      console.warn("move custom text backend write failed", error);
      showToast(t("toast.saveUnavailable"), "error");
      return false;
    }
    const moved = moveCustomTextToProfile(id, targetLang);
    if (!moved) return false;
    const { textObj, newId } = moved;
    movedCustom = { oldId: id, newId, textBody };
    if (!window.__qtBridge) textObj.text = textBody;
    if (textBody) bookTexts.set(newId, textBody);
    if (!isCustomTextReferenced(id)) bookTexts.delete(id);
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
    await saveStateAndReloadBridge({ withSnapshot: true });
  } catch (error) {
    console.warn("move book profile save failed", error);
    let recovered = false;
    try {
      recovered = await reloadBridgeSnapshot();
    } catch (reloadError) {
      console.warn("move book recovery reload failed", reloadError);
    }
    if (movedCustom && recovered) {
      restoreMoveUiState(previousUiState);
      bookTexts.delete(movedCustom.newId);
      if (movedCustom.textBody) bookTexts.set(movedCustom.oldId, movedCustom.textBody);
      invalidateBookId(movedCustom.oldId);
      invalidateBookId(movedCustom.newId);
      if (window.__qtBridge && !isCustomTextReferenced(movedCustom.newId)) {
        await deleteStoredText(movedCustom.newId).catch((cleanupError) => {
          console.warn("move custom text rollback cleanup failed", cleanupError);
        });
      }
    }
    if (!movedCustom && recovered) restoreMoveUiState(previousUiState);
    showToast(t("toast.saveUnavailable"), "error");
    return false;
  }
  if (movedCustom && window.__qtBridge && !isCustomTextReferenced(movedCustom.oldId)) {
    await deleteStoredText(movedCustom.oldId).catch((cleanupError) => {
      console.warn("move custom text cleanup failed", cleanupError);
    });
  }
  render();
  showToast(t("toast.bookMoved"));
  return true;
}

// Both removers are awaited by the library delete dialog so it can keep a
// busy indicator on screen until the durable save (which can take seconds
// on large stores) settles.
export async function removeUserBook(id: string): Promise<void> {
  const fullTextIds = forgetUserBookWithFullText(id);
  if (!fullTextIds) return;
  await saveState();
  // As in removeCustomText, the cached full text's body lives in the store.
  if (window.__qtBridge) {
    for (const textId of fullTextIds) {
      if (isCustomTextReferenced(textId)) continue;
      await deleteStoredText(textId).catch((error) => {
        console.warn("delete_text media cleanup failed", error);
      });
    }
  }
  render();
  showToast(t("toast.userBookRemoved"));
}

/**
 * Drops a user book and its reader state from the active profile, without
 * saving, together with the Gutenberg full text cached for it (that copy has
 * no Library card of its own).
 */
export function forgetUserBook(id: string): boolean {
  return forgetUserBookWithFullText(id) !== null;
}

/** forgetUserBook, returning the removed full-text ids (null: no such book). */
function forgetUserBookWithFullText(id: string): string[] | null {
  const book = removeUserBookFromActiveProfile(id);
  if (!book) return null;
  const fullTextIds = gutenbergFullTextIds(book.gutenbergId, state.preferences.learningLanguage)
    .filter((textId) => removeCustomTextFromActiveProfile(textId));
  [id, ...fullTextIds].forEach(forgetBookState);
  return fullTextIds;
}

function forgetBookState(id: string): void {
  clearBookTextCache(id);
  forgetReaderPositionIfUnreferenced(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
}

export async function hideBuiltInBook(id: string): Promise<void> {
  if (!hideBuiltInBookId(id)) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);
  await saveState();
  render();
  showToast(t("toast.bookHidden"));
}
