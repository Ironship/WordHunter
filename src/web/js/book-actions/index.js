/**
 * Book actions orchestrator: open/open-last + re-exports of the split submodules.
 * Keeps the historical `./book-actions.js` public API intact.
 */
import { state, setLastReadTextId, getLastReadTextId } from "../state.js";
import { setView, render } from "../render.js";
import { rememberReaderScrollPosition, setReaderLoading, clearReaderLoading } from "../views/reader.js";
import { bookTexts, loadBookText, findBookById } from "../books.js";

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

export function isReadableBookAvailable(id) {
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

export {
  importCustomText,
  removeCustomText,
  slugify
} from "./custom-text.js";

export {
  pendingEditCoverDataUrl,
  setPendingEditCoverDataUrl,
  isEditBookDirty,
  openEditBookModal,
  cancelEditBook,
  saveEditedBook,
  pasteImageToEditBook
} from "./edit-modal.js";

export {
  archiveBook,
  unarchiveBook,
  hideBuiltInBook,
  removeUserBook,
  moveBookToProfile
} from "./library-ops.js";

export {
  loadFullGutenbergText,
  addUserBook
} from "./sources.js";
