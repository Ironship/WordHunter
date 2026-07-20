import { state, setLastReadTextId, getLastReadTextId } from "./state.js";
import { getNavigationEpoch, setView } from "./render.js";
import { setReaderLoading, clearReaderLoading, renderReader } from "./reader/renderer.js";
import { rememberReaderScrollPosition } from "./reader/scroll.js";
import { bookTexts, findBookById, isBookTextCacheStale, loadBookText, loadCustomTextContent } from "./books.js";
import { findCustomText, hasCustomText } from "./book-actions/profile-library.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";

let openBookGeneration = 0;

export async function openBook(id: string) {
  const generation = ++openBookGeneration;
  const startingNavigationEpoch = getNavigationEpoch();
  clearReaderLoading();
  rememberReaderScrollPosition();
  const customText = findCustomText(id);
  const isCustom = Boolean(customText);
  if (!bookTexts.has(id) || isBookTextCacheStale(id)) {
    const catalogBook = findBookById(id);
    const book = customText || catalogBook;
    if (book) {
      try {
        setReaderLoading({ title: book.title || "..." });
        if (isCustom && window.__qtBridge) {
          await loadCustomTextContent(customText);
          if (generation !== openBookGeneration) return false;
        } else if (isCustom && customText?.text) {
          bookTexts.set(id, customText.text);
        } else if (catalogBook) {
          await loadBookText(catalogBook);
        }
      } catch (e) {
        console.warn("fetch text failed", e);
      } finally {
        if (generation === openBookGeneration) clearReaderLoading();
      }
    }
  }

  if (generation !== openBookGeneration || startingNavigationEpoch !== getNavigationEpoch()) return false;
  const text = bookTexts.get(id);
  if (typeof text !== "string" || !text.trim()) {
    showToast(t("toast.noTextSource"), "error");
    if (state.currentView === "reader") renderReader();
    return false;
  }

  const algorithm = state.preferences.wordDetectionAlgorithm === "classic" ? "classic" : "modern";
  await import("./reader/bookmarks.js")
    .then(({ remapReaderBookmarksForAlgorithm }) => remapReaderBookmarksForAlgorithm(algorithm, id))
    .catch((error) => console.warn("bookmark remap failed", error));
  if (generation !== openBookGeneration || startingNavigationEpoch !== getNavigationEpoch()) return false;

  state.currentTextId = id;
  setLastReadTextId(id);
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  window.lastActiveToken = null;
  setView("reader");
  return true;
}

export function isReadableBookAvailable(id: string | null) {
  if (!id) return false;
  return hasCustomText(id) || !!findBookById(id);
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
} from "./book-actions/custom-text.js";

export {
  pendingEditCoverDataUrl,
  setPendingEditCoverDataUrl,
  isEditBookDirty,
  openEditBookModal,
  cancelEditBook,
  saveEditedBook,
  pasteImageToEditBook
} from "./book-actions/edit-modal.js";

export {
  archiveBook,
  unarchiveBook,
  hideBuiltInBook,
  removeUserBook,
  moveBookToProfile
} from "./book-actions/library-ops.js";

export {
  loadFullGutenbergText,
  addUserBook
} from "./book-actions/sources.js";
