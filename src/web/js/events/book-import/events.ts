// Import form / edit-book dialog event binding (the interactive layer of the
// former monolithic book-import.ts).
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import { showToast } from "../../toast.js";
import { isAndroidPlatform } from "../../platform.js";
import { registerUnsavedDialog } from "../../dialog-backdrop.js";
import { beginElementBusy, setElementBusy } from "../../loading.js";
import { deleteStoredText } from "../../store-bridge.js";
import { isOcrImageFile, validatedOcrImageFormat } from "../../ocr-image-format.js";
import { parseImportedTextFile, titleFromImportedFileName } from "../../subtitles.js";
import {
  cancelEditBook,
  importCustomText,
  isEditBookDirty,
  pasteImageToEditBook,
  saveEditedBook,
  updateEditBookCounter,
  wrapEditBookSelection
} from "../../book-actions.js";
import {
  el,
  isEbookFile,
  isPdfFile,
  safeImportErrorMessage,
  setImportCoverPreview,
  setImportLoading,
  resetCoverPreview,
  clearPendingImportMeta,
  getPendingCoverDataUrl,
  setPendingCoverDataUrl,
  getPendingImportMeta,
  type ClipboardEventWithOriginal,
  type ImportMeta,
} from "./shared.js";
import { handleYoutubeImport, loadYoutubeTracks, resetYoutubeTracks } from "./youtube.js";
import { importPdfFile, importOcrImageFile } from "./pdf-ocr.js";
import { loadImportFile } from "./loaders.js";

function handleImportCoverFile(file: File | undefined): void {
  if (!file) return;
  if (file.size > 1_500_000) {
    showToast(t("toast.coverTooBig"));
    const importCover = el<HTMLInputElement>("import-cover");
    if (importCover) importCover.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { setImportCoverPreview(String(reader.result || "")); };
  reader.readAsDataURL(file);
}

function handleEditCoverFile(file: File | undefined): void {
  if (!file) return;
  if (file.size > 1_500_000) {
    showToast(t("toast.coverTooBig"));
    const editCoverInput = document.getElementById("edit-book-cover") as HTMLInputElement | null;
    if (editCoverInput) editCoverInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    import("../../book-actions.js").then(m => m.setPendingEditCoverDataUrl(dataUrl));
    const editCoverImg = document.getElementById("edit-book-cover-img") as HTMLImageElement | null;
    if (editCoverImg) editCoverImg.src = dataUrl;
    const editCoverPreview = document.getElementById("edit-book-cover-preview");
    if (editCoverPreview) editCoverPreview.hidden = false;
    const dropzone = document.getElementById("edit-book-cover-dropzone");
    if (dropzone) dropzone.style.display = "none";
  };
  reader.readAsDataURL(file);
}

function bindImportFormEvents() {
  const importModeSelect = el<HTMLSelectElement>("import-mode-select");
  if (importModeSelect) {
    importModeSelect.addEventListener("change", () => {
      const mode = importModeSelect.value;
      const importBooksMode = el<HTMLElement>("import-books-mode");
      if (importBooksMode) importBooksMode.hidden = mode !== "books";
      const importYoutubeMode = el<HTMLElement>("import-youtube-mode");
      if (importYoutubeMode) importYoutubeMode.hidden = mode !== "youtube";
    });
  }

  const importYoutubeLoad = el<HTMLButtonElement>("import-youtube-load");
  if (importYoutubeLoad) {
    importYoutubeLoad.addEventListener("click", () => handleYoutubeImport());
  }

  const importYoutubeUrl = el<HTMLInputElement>("import-youtube-url");
  if (importYoutubeUrl) {
    importYoutubeUrl.addEventListener("input", () => {
      clearPendingImportMeta();
      resetYoutubeTracks(false);
    });
    importYoutubeUrl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleYoutubeImport();
      }
    });
  }

  const importFile = el<HTMLInputElement>("import-file");
  if (importFile) {
    importFile.addEventListener("change", async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      const releaseBusy = beginElementBusy(importFile.closest?.(".file-button"));
      try {
        if (await loadImportFile(file) !== false) showToast(t("toast.fileLoaded", { name: file.name }));
      } catch (err) {
        console.warn(err);
        showToast(safeImportErrorMessage(err), "error");
      } finally {
        releaseBusy();
      }
    });
  }

  const importCover = el<HTMLInputElement>("import-cover");
  if (importCover) {
    importCover.addEventListener("change", () => handleImportCoverFile(importCover.files?.[0]));
  }

  const importCoverClear = el<HTMLButtonElement>("import-cover-clear");
  if (importCoverClear) {
    importCoverClear.addEventListener("click", () => {
      setPendingCoverDataUrl(null);
      const coverImg = el<HTMLImageElement>("import-cover-img");
      if (coverImg) coverImg.src = "";
      const coverPreview = el<HTMLElement>("import-cover-preview");
      if (coverPreview) coverPreview.hidden = true;
      const coverInput = el<HTMLInputElement>("import-cover");
      if (coverInput) coverInput.value = "";
      const dropzone = document.getElementById("import-cover-dropzone");
      if (dropzone) dropzone.style.display = "flex";
    });
  }

  const importForm = el<HTMLFormElement>("import-form");
  if (importForm) {
    importForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = event.submitter instanceof HTMLButtonElement
        ? event.submitter
        : document.querySelector<HTMLButtonElement>("#import-submit");
      if (submitButton?.disabled) return;
      const releaseButton = beginElementBusy(submitButton, { disable: true });
      const releaseForm = beginElementBusy(importForm);
      const meta: ImportMeta = {
        ...getPendingImportMeta(),
        author: el<HTMLInputElement>("import-author")?.value || getPendingImportMeta().author,
        tags: el<HTMLInputElement>("import-tags")?.value,
        coverDataUrl: getPendingCoverDataUrl()
      };
      const levelVal = el<HTMLSelectElement>("import-level")?.value;
      if (levelVal) meta.level = levelVal;
      try {
        const importedId = await importCustomText(
          el<HTMLInputElement>("import-title")?.value || "",
          el<HTMLTextAreaElement>("import-text")?.value || "",
          meta
        );
        if (!importedId) return;
        importForm.reset();
        clearPendingImportMeta();
        resetYoutubeTracks(true);
        resetCoverPreview();
      } catch (e) {
        console.error("import custom text failed", e);
      } finally {
        releaseForm();
        releaseButton();
      }
    });
  }
}

function bindEditBookEvents() {
  registerUnsavedDialog("edit-book-dialog", isEditBookDirty, () => saveEditedBook(), () => cancelEditBook());
  const editBookDialog = document.getElementById("edit-book-dialog") as HTMLDialogElement | null;
  const editBookCancel = document.getElementById("edit-book-cancel") as HTMLButtonElement | null;
  const editBookSave = document.getElementById("edit-book-save") as HTMLButtonElement | null;
  const editBookCoverClear = document.getElementById("edit-book-cover-clear") as HTMLButtonElement | null;
  const editBookCover = document.getElementById("edit-book-cover") as HTMLInputElement | null;
  const editBookText = document.getElementById("edit-book-text") as HTMLTextAreaElement | null;
  if (editBookCancel) editBookCancel.addEventListener("click", () => cancelEditBook());
  if (editBookSave) editBookSave.addEventListener("click", () => saveEditedBook());

  const fmtBold = document.getElementById("edit-book-fmt-bold");
  const fmtItalic = document.getElementById("edit-book-fmt-italic");
  if (fmtBold) fmtBold.addEventListener("click", () => wrapEditBookSelection("**"));
  if (fmtItalic) fmtItalic.addEventListener("click", () => wrapEditBookSelection("*"));
  if (editBookText) {
    editBookText.addEventListener("input", updateEditBookCounter);
  }

  if (editBookDialog) {
    editBookDialog.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement)
        && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        saveEditedBook();
      }
    });
  }

  if (editBookCoverClear) {
    editBookCoverClear.addEventListener("click", () => {
      import("../../book-actions.js").then(m => m.setPendingEditCoverDataUrl(null));
      const coverImg = document.getElementById("edit-book-cover-img") as HTMLImageElement | null;
      if (coverImg) coverImg.src = "";
      const coverPreview = document.getElementById("edit-book-cover-preview");
      if (coverPreview) coverPreview.hidden = true;
      const coverInput = document.getElementById("edit-book-cover") as HTMLInputElement | null;
      if (coverInput) coverInput.value = "";
      const dropzone = document.getElementById("edit-book-cover-dropzone");
      if (dropzone) dropzone.style.display = "flex";
    });
  }

  if (editBookCover) {
    editBookCover.addEventListener("change", () => handleEditCoverFile(editBookCover.files?.[0]));
  }

  if (editBookText) {
    editBookText.addEventListener("paste", (e) => {
      const clipboardEvent = e as ClipboardEventWithOriginal;
      const items = (clipboardEvent.clipboardData || clipboardEvent.originalEvent?.clipboardData)?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.indexOf("image") === 0) {
          const file = item.getAsFile();
          if (file) pasteImageToEditBook(file);
          e.preventDefault();
          e.stopPropagation();
        }
      }
    });
  }
}

function isTextEditingPasteTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("textarea, input, [contenteditable='true']");
}

function bindCoverPasteEvents() {
  document.addEventListener("paste", (e) => {
    if (isTextEditingPasteTarget(e.target)) return;
    const importOpen = state.currentView === "library";
    const editOpen = (document.getElementById("edit-book-dialog") as HTMLDialogElement | null)?.open ?? false;
    if (!importOpen && !editOpen) return;
    const clipboardEvent = e as ClipboardEventWithOriginal;
    const items = (clipboardEvent.clipboardData || clipboardEvent.originalEvent?.clipboardData)?.items;
    if (!items) return;
    let handled = false;
    for (let index in items) {
      const item = items[index];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          handled = true;
          if (editOpen) handleEditCoverFile(file);
          else if (importOpen) handleImportCoverFile(file);
        }
      }
    }
    if (handled) e.preventDefault();
  });
}

export function bindBookImportEvents() {
  bindImportFormEvents();
  bindEditBookEvents();
  bindCoverPasteEvents();
}
