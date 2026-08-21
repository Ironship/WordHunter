/**
 * Edit-book modal: module state, dirty tracking, open/cancel/save, image paste.
 */
import { state } from "../state.js";
import { showToast as displayToast } from "../toast.js";
import { bookTexts, findBookById, loadCustomTextContent } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { formatTagList, parseTagList } from "../utils.js";
import { t as translate } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../reader/renderer.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "../bridge-commit.js";
import { upsertStoredText } from "../store-bridge.js";

/**
 * Builds the edit-book dialog markup once (idempotent). Called during app
 * boot before cacheElements() (app.ts); the edit-book consumers resolve the
 * elements via getElementById (editBookEl), so boot order guarantees they
 * exist.
 */
export function renderEditBookDialog(): HTMLDialogElement {
  const existing = document.getElementById("edit-book-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#edit-book-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "edit-book-dialog";
  dialog.className = "panel edit-book-dialog";
  dialog.setAttribute("aria-labelledby", "edit-book-title-heading");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 id="edit-book-title-heading" data-i18n="editBook.title">Edit book</h2>
    </div>
    <div class="settings-body edit-book-body">
      <label class="setting-row edit-book-field">
        <span data-i18n="editBook.titleLabel">Title</span>
        <input id="edit-book-title" type="text" class="input w-100">
      </label>
      <label class="setting-row edit-book-field">
        <span data-i18n="editBook.authorLabel">Author</span>
        <input id="edit-book-author" type="text" class="input w-100">
      </label>
      <label class="setting-row edit-book-field">
        <span data-i18n="editBook.tagsLabel">Tags</span>
        <input id="edit-book-tags" type="text" class="input w-100" data-i18n-attr="placeholder=import.tagsPlaceholder">
      </label>
      <label class="setting-row edit-book-field">
        <span data-i18n="editBook.levelLabel">Level</span>
        <select id="edit-book-level" class="input w-100">
          <option value="" data-i18n="library.levelAny">Any</option>
          <option value="A1">A1</option>
          <option value="A2">A2</option>
          <option value="B1">B1</option>
          <option value="B2">B2</option>
          <option value="C1">C1</option>
          <option value="C2">C2</option>
        </select>
      </label>
      <div class="setting-row edit-book-field">
        <span data-i18n="editBook.coverLabel">Cover</span>
        <div class="edit-book-cover-row">
          <div id="edit-book-cover-preview" class="edit-book-cover-preview" hidden>
            <img id="edit-book-cover-img" src="" data-i18n-attr="alt=editBook.coverPreviewAlt" alt="Cover preview">
            <button id="edit-book-cover-clear" class="edit-book-cover-clear" type="button" data-i18n-attr="title=editBook.deleteCover">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-14"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <label for="edit-book-cover" class="edit-book-cover-dropzone" id="edit-book-cover-dropzone" data-i18n-attr="title=editBook.changeCover">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-28-muted-m-b-05"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <span data-i18n="import.coverPasteHint" class="fs-085-muted-center">Click to select or paste</span>
            <input id="edit-book-cover" type="file" accept="image/*" class="visually-hidden">
          </label>
        </div>
      </div>
      <label class="setting-row edit-book-field edit-book-text-field">
        <span data-i18n="editBook.textLabel">Text (You can paste images with Ctrl+V)</span>
        <div class="edit-book-format-bar">
          <button id="edit-book-fmt-bold" class="icon-button" type="button" data-i18n-attr="title=editBook.formatBold" title="Bold (**text**)"><strong>B</strong></button>
          <button id="edit-book-fmt-italic" class="icon-button" type="button" data-i18n-attr="title=editBook.formatItalic" title="Italic (*text*)"><em>I</em></button>
          <span class="edit-book-format-hint fs-085-muted" data-i18n="editBook.formatHint">**bold** · *italic* — markers are hidden in the Reader</span>
        </div>
        <textarea id="edit-book-text" class="input" spellcheck="false"></textarea>
        <span id="edit-book-text-counter" class="fs-085-muted edit-book-counter" aria-live="off"></span>
      </label>
      <div class="edit-book-actions">
        <button id="edit-book-cancel" class="secondary-button" data-i18n="editBook.cancel">Cancel</button>
        <button id="edit-book-save" class="primary-button" data-i18n="editBook.save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

/** Resolves an edit-book dialog element by id (rendered at boot, so present). */
function editBookEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const t = translate as (key: string, vars?: WhRecord) => string;
const showToast = displayToast as (message: string, kind?: string) => void;

let editingBookId: string | null = null;
let editingBookKind: "custom" | "user" | null = null;
export let pendingEditCoverDataUrl: string | null = null;
let editBookOriginalValues: EditBookOriginalValues | null = null;
let editBookGeneration = 0;
let editBookSaveRunning = false;

interface EditBookOriginalValues {
  title: string;
  author: string;
  tags: string;
  level: string;
  text: string;
  cover: string | null;
}

export function setPendingEditCoverDataUrl(url: string | null): void {
  pendingEditCoverDataUrl = url;
}

export function isEditBookDirty(): boolean {
  if (!editBookOriginalValues) return false;
  const title = editBookEl<HTMLInputElement>("edit-book-title")?.value ?? "";
  const author = editBookEl<HTMLInputElement>("edit-book-author")?.value ?? "";
  const tags = editBookEl<HTMLInputElement>("edit-book-tags")?.value ?? "";
  const level = editBookEl<HTMLSelectElement>("edit-book-level")?.value ?? "";
  const text = editBookEl<HTMLTextAreaElement>("edit-book-text")?.value ?? "";
  return title !== editBookOriginalValues.title
    || author !== editBookOriginalValues.author
    || tags !== editBookOriginalValues.tags
    || level !== editBookOriginalValues.level
    || text !== editBookOriginalValues.text
    || pendingEditCoverDataUrl !== editBookOriginalValues.cover;
}

export async function openEditBookModal(id: string): Promise<void> {
  if (editBookSaveRunning) return;
  const generation = ++editBookGeneration;
  const customText = state.customTexts.find(t => t.id === id);
  const userBook = !customText ? state.userBooks.find((book) => book.id === id) : null;
  const builtInBook = !customText && !userBook ? findBookById(id) : null;
  const book = customText || userBook || builtInBook;
  if (!book || builtInBook) return;
  editingBookId = id;
  editingBookKind = customText ? "custom" : "user";

  const titleInput = editBookEl<HTMLInputElement>("edit-book-title");
  const authorInput = editBookEl<HTMLInputElement>("edit-book-author");
  const tagsInput = editBookEl<HTMLInputElement>("edit-book-tags");
  const levelSelect = editBookEl<HTMLSelectElement>("edit-book-level");
  const textArea = editBookEl<HTMLTextAreaElement>("edit-book-text");
  const coverImg = editBookEl<HTMLImageElement>("edit-book-cover-img");
  const coverPreview = editBookEl<HTMLElement>("edit-book-cover-preview");
  const dialog = editBookEl<HTMLDialogElement>("edit-book-dialog");

  if (titleInput) titleInput.value = book.title || "";
  if (authorInput) authorInput.value = book.author || "";
  if (tagsInput) tagsInput.value = formatTagList(book.tags);
  if (levelSelect) levelSelect.value = book.level || "";

  let customBody = "";
  if (customText) {
    try {
      customBody = await loadCustomTextContent(customText);
    } catch (error) {
      console.warn("edit book body refresh failed", error);
      if (generation === editBookGeneration && editingBookId === id) {
        editingBookId = null;
        editingBookKind = null;
        editBookOriginalValues = null;
        showToast(t("toast.saveUnavailable"), "error");
      }
      return;
    }
  }
  if (generation !== editBookGeneration || editingBookId !== id) return;
  if (textArea) {
    textArea.value = customText ? customBody : bookTexts.get(id) || "";
    textArea.readOnly = editingBookKind !== "custom" || Array.isArray(customText?.pdfOcrPages);
  }
  updateEditBookCounter();

  const coverUrl = typeof book.coverDataUrl === "string" ? book.coverDataUrl : "";
  pendingEditCoverDataUrl = coverUrl;
  if (pendingEditCoverDataUrl) {
    if (coverImg) coverImg.src = pendingEditCoverDataUrl;
    if (coverPreview) coverPreview.hidden = false;
  } else {
    if (coverImg) coverImg.src = "";
    if (coverPreview) coverPreview.hidden = true;
  }

  editBookOriginalValues = {
    title: titleInput?.value ?? "",
    author: authorInput?.value ?? "",
    tags: tagsInput?.value || "",
    level: levelSelect?.value || "",
    text: textArea?.value ?? "",
    cover: pendingEditCoverDataUrl
  };

  dialog?.showModal();
}

export function cancelEditBook(): void {
  if (editBookSaveRunning) return;
  editBookGeneration += 1;
  editBookOriginalValues = null;
  pendingEditCoverDataUrl = null;
  editingBookId = null;
  editingBookKind = null;
  const textArea = editBookEl<HTMLTextAreaElement>("edit-book-text");
  if (textArea) textArea.readOnly = false;
  editBookEl<HTMLDialogElement>("edit-book-dialog")?.close();
}

export async function saveEditedBook(): Promise<void> {
  if (!editingBookId || editBookSaveRunning) return;
  editBookSaveRunning = true;
  const targetBookId = editingBookId;
  const customText = state.customTexts.find(t => t.id === targetBookId);
  const userBook = !customText ? state.userBooks.find((book) => book.id === targetBookId) : null;
  const cancelButton = editBookEl<HTMLButtonElement>("edit-book-cancel");
  const saveButton = editBookEl<HTMLButtonElement>("edit-book-save");
  const titleInput = editBookEl<HTMLInputElement>("edit-book-title");
  const authorInput = editBookEl<HTMLInputElement>("edit-book-author");
  const tagsInput = editBookEl<HTMLInputElement>("edit-book-tags");
  const levelSelect = editBookEl<HTMLSelectElement>("edit-book-level");
  const textArea = editBookEl<HTMLTextAreaElement>("edit-book-text");
  const dialog = editBookEl<HTMLDialogElement>("edit-book-dialog");
  if (cancelButton) cancelButton.disabled = true;
  if (saveButton) { saveButton.disabled = true; saveButton.classList.add("is-busy"); }
  if (!customText && !userBook) {
    editBookSaveRunning = false;
    if (cancelButton) cancelButton.disabled = false;
    if (saveButton) { saveButton.disabled = false; saveButton.classList.remove("is-busy"); }
    return;
  }

  const cleanTitle = (titleInput?.value ?? "").trim();
  const cleanText = (textArea?.value ?? "").trim();
  if (!cleanTitle || (customText && !cleanText)) {
    showToast(t("toast.emptyFields"));
    editBookSaveRunning = false;
    if (cancelButton) cancelButton.disabled = false;
    if (saveButton) { saveButton.disabled = false; saveButton.classList.remove("is-busy"); }
    return;
  }

  if (customText) {
    const nextCustomText = {
      ...customText,
      title: cleanTitle,
      author: (authorInput?.value ?? "").trim(),
      tags: parseTagList(tagsInput?.value),
      coverDataUrl: pendingEditCoverDataUrl,
      level: levelSelect?.value || "",
      updatedAt: new Date().toISOString()
    };
    try {
      if (window.__qtBridge) await upsertStoredText({ ...nextCustomText, text: cleanText });
    } catch(e) {
      console.warn("upsert_text failed", e);
      showToast(t("toast.saveUnavailable"), "error");
      editBookSaveRunning = false;
      if (cancelButton) cancelButton.disabled = false;
      if (saveButton) { saveButton.disabled = false; saveButton.classList.remove("is-busy"); }
      return;
    }
    Object.assign(customText, nextCustomText);
    if (!window.__qtBridge) customText.text = cleanText;
    bookTexts.set(targetBookId, cleanText);
  } else if (userBook) {
    Object.assign(userBook, {
      title: cleanTitle,
      author: (authorInput?.value ?? "").trim(),
      tags: parseTagList(tagsInput?.value),
      coverDataUrl: pendingEditCoverDataUrl,
      level: levelSelect?.value || "",
      updatedAt: new Date().toISOString()
    });
  }
  invalidateBookId(targetBookId);

  try {
    await saveStateAndReloadBridge({ withSnapshot: true });
  } catch (error) {
    console.warn("save edited book failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("edit book recovery reload failed", reloadError);
    });
    showToast(t("toast.saveUnavailable"), "error");
    editBookSaveRunning = false;
    if (cancelButton) cancelButton.disabled = false;
    if (saveButton) { saveButton.disabled = false; saveButton.classList.remove("is-busy"); }
    return;
  }
  renderLibrary();
  // Re-render the reader only when it is actually visible — the text changed,
  // and the render re-tokenizes the whole book (heavy for large books). When
  // another view is active, the next switch to the reader re-renders anyway.
  if (state.currentTextId === targetBookId && state.currentView === "reader") renderReader();
  showToast(t("toast.textSaved"));
  editBookOriginalValues = null;
  if (textArea) textArea.readOnly = false;
  dialog?.close();
  editingBookId = null;
  editingBookKind = null;
  editBookSaveRunning = false;
  if (cancelButton) cancelButton.disabled = false;
  if (saveButton) { saveButton.disabled = false; saveButton.classList.remove("is-busy"); }
}

/** Wraps the textarea selection with a markdown-lite marker (`**` or `*`).
 *  No selection wraps/unwrap the word at the cursor. Keyboard-driven from
 *  the format bar; markers are stripped before tokenization (format-markers). */
export function wrapEditBookSelection(marker: "**" | "*"): void {
  const textarea = editBookEl<HTMLTextAreaElement>("edit-book-text");
  if (!textarea || textarea.readOnly) return;
  const { selectionStart, selectionEnd, value } = textarea;
  // Unwrap when the exact selection is already fully wrapped.
  if (value.slice(selectionStart - marker.length, selectionStart) === marker
    && value.slice(selectionEnd, selectionEnd + marker.length) === marker) {
    textarea.value = value.slice(0, selectionStart - marker.length)
      + value.slice(selectionStart, selectionEnd)
      + value.slice(selectionEnd + marker.length);
    textarea.selectionStart = selectionStart - marker.length;
    textarea.selectionEnd = selectionEnd - marker.length;
  } else if (selectionStart !== selectionEnd) {
    textarea.value = value.slice(0, selectionStart) + marker
      + value.slice(selectionStart, selectionEnd) + marker
      + value.slice(selectionEnd);
    textarea.selectionStart = selectionStart + marker.length;
    textarea.selectionEnd = selectionEnd + marker.length;
  } else {
    textarea.value = value.slice(0, selectionStart) + marker + marker + value.slice(selectionEnd);
    textarea.selectionStart = selectionStart + marker.length;
    textarea.selectionEnd = selectionStart + marker.length;
  }
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

const WORD_COUNT_RE = /\S+/g;

/** Lightweight words+chars counter shown under the edit textarea. */
export function updateEditBookCounter(): void {
  const counter = editBookEl<HTMLElement>("edit-book-text-counter");
  const textarea = editBookEl<HTMLTextAreaElement>("edit-book-text");
  if (!counter || !textarea) return;
  const text = textarea.value;
  const chars = text.length;
  WORD_COUNT_RE.lastIndex = 0;
  let words = 0;
  while (WORD_COUNT_RE.exec(text)) words += 1;
  counter.textContent = `${words} · ${chars}`;
}

export async function pasteImageToEditBook(file: File): Promise<void> {
  if (!editingBookId) return;
  if (file.size > 16 * 1024 * 1024) {
    showToast(t("toast.importFailed"), "error");
    return;
  }
  const targetBookId = editingBookId;
  const generation = editBookGeneration;
  const ext = file.type.split("/")[1] || "png";
  const imgName = `img_${Date.now()}.${ext}`;

  const reader = new FileReader();
  reader.onload = async () => {
    if (generation !== editBookGeneration || editingBookId !== targetBookId) return;
    const base64Data = typeof reader.result === "string" ? reader.result : "";
    const textarea = editBookEl<HTMLTextAreaElement>("edit-book-text");
    if (!textarea) return;
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    const textToInsert = `\n[IMG:${imgName}]\n`;
    try {
      if (!window.__qtBridge) throw new Error("book image storage is unavailable");
      const response = await fetch("/__book/image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({ book_id: targetBookId, img_name: imgName, base64_data: base64Data })
      });
      if (!response.ok) throw new Error(`book image upload HTTP ${response.status}`);
      if (generation !== editBookGeneration || editingBookId !== targetBookId) return;
      textarea.value = textarea.value.substring(0, startPos) + textToInsert + textarea.value.substring(endPos, textarea.value.length);
      textarea.selectionStart = startPos + textToInsert.length;
      textarea.selectionEnd = startPos + textToInsert.length;
    } catch (error) {
      console.warn("Image upload failed", error);
      showToast(t("toast.importFailed"), "error");
    }
  };
  reader.onerror = () => showToast(t("toast.importFailed"), "error");
  reader.readAsDataURL(file);
}
