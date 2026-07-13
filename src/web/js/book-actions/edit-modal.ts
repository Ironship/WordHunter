/**
 * Edit-book modal: module state, dirty tracking, open/cancel/save, image paste.
 */
import { state } from "../state.js";
import { els as domElements } from "../dom.js";
import { showToast as displayToast } from "../toast.js";
import { bookTexts, findBookById } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { formatTagList, parseTagList } from "../utils.js";
import { t as translate } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../reader/renderer.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "../bridge-commit.js";
import { upsertStoredText } from "../store-bridge.js";

interface EditBookElements {
  editBookTitle: HTMLInputElement;
  editBookAuthor: HTMLInputElement;
  editBookTags?: HTMLInputElement;
  editBookLevel?: HTMLSelectElement;
  editBookText: HTMLTextAreaElement;
  editBookCoverImg: HTMLImageElement;
  editBookCoverPreview: HTMLElement;
  editBookDialog: HTMLDialogElement;
  editBookCancel?: HTMLButtonElement;
  editBookSave?: HTMLButtonElement;
}

interface EditBookOriginalValues {
  title: string;
  author: string;
  tags: string;
  level: string;
  text: string;
  cover: string | null;
}

const els = domElements as EditBookElements;
const t = translate as (key: string, vars?: WhRecord) => string;
const showToast = displayToast as (message: string, kind?: string) => void;

let editingBookId: string | null = null;
let editingBookKind: "custom" | "user" | null = null;
export let pendingEditCoverDataUrl: string | null = null;
let editBookOriginalValues: EditBookOriginalValues | null = null;
let editBookGeneration = 0;
let editBookSaveRunning = false;

export function setPendingEditCoverDataUrl(url: string | null): void {
  pendingEditCoverDataUrl = url;
}

export function isEditBookDirty(): boolean {
  if (!editBookOriginalValues) return false;
  const title = els.editBookTitle.value;
  const author = els.editBookAuthor.value;
  const tags = els.editBookTags?.value || "";
  const level = els.editBookLevel?.value || "";
  const text = els.editBookText.value;
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

  els.editBookTitle.value = book.title || "";
  els.editBookAuthor.value = book.author || "";
  if (els.editBookTags) els.editBookTags.value = formatTagList(book.tags);
  if (els.editBookLevel) els.editBookLevel.value = book.level || "";

  if (customText && window.__qtBridge && !bookTexts.has(id)) {
    try {
      const res = await fetch(`/__book/text?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (typeof data === "object" && data !== null && "text" in data && typeof data.text === "string" && data.text) {
        bookTexts.set(id, data.text);
      }
    } catch(e) { console.warn(e); }
  }
  if (generation !== editBookGeneration || editingBookId !== id) return;
  els.editBookText.value = bookTexts.get(id) || (customText && customText.text) || "";
  els.editBookText.readOnly = editingBookKind !== "custom" || Array.isArray(customText?.pdfOcrPages);

  const coverUrl = typeof book.coverDataUrl === "string" ? book.coverDataUrl : "";
  pendingEditCoverDataUrl = coverUrl;
  if (pendingEditCoverDataUrl) {
    els.editBookCoverImg.src = pendingEditCoverDataUrl;
    els.editBookCoverPreview.hidden = false;
  } else {
    els.editBookCoverImg.src = "";
    els.editBookCoverPreview.hidden = true;
  }

  editBookOriginalValues = {
    title: els.editBookTitle.value,
    author: els.editBookAuthor.value,
    tags: els.editBookTags?.value || "",
    level: els.editBookLevel?.value || "",
    text: els.editBookText.value,
    cover: pendingEditCoverDataUrl
  };

  els.editBookDialog.showModal();
}

export function cancelEditBook(): void {
  if (editBookSaveRunning) return;
  editBookGeneration += 1;
  editBookOriginalValues = null;
  pendingEditCoverDataUrl = null;
  editingBookId = null;
  editingBookKind = null;
  if (els.editBookText) els.editBookText.readOnly = false;
  els.editBookDialog.close();
}

export async function saveEditedBook(): Promise<void> {
  if (!editingBookId || editBookSaveRunning) return;
  editBookSaveRunning = true;
  const targetBookId = editingBookId;
  const customText = state.customTexts.find(t => t.id === targetBookId);
  const userBook = !customText ? state.userBooks.find((book) => book.id === targetBookId) : null;
  if (els.editBookCancel) els.editBookCancel.disabled = true;
  if (els.editBookSave) els.editBookSave.disabled = true;
  if (!customText && !userBook) {
    editBookSaveRunning = false;
    if (els.editBookCancel) els.editBookCancel.disabled = false;
    if (els.editBookSave) els.editBookSave.disabled = false;
    return;
  }

  const cleanTitle = els.editBookTitle.value.trim();
  const cleanText = els.editBookText.value.trim();
  if (!cleanTitle || (customText && !cleanText)) {
    showToast(t("toast.emptyFields"));
    editBookSaveRunning = false;
    if (els.editBookCancel) els.editBookCancel.disabled = false;
    if (els.editBookSave) els.editBookSave.disabled = false;
    return;
  }

  if (customText) {
    const nextCustomText = {
      ...customText,
      title: cleanTitle,
      author: els.editBookAuthor.value.trim(),
      tags: parseTagList(els.editBookTags?.value),
      coverDataUrl: pendingEditCoverDataUrl,
      level: els.editBookLevel?.value || "",
      updatedAt: new Date().toISOString()
    };
    try {
      if (window.__qtBridge) await upsertStoredText({ ...nextCustomText, text: cleanText });
    } catch(e) {
      console.warn("upsert_text failed", e);
      showToast(t("toast.syncUnavailable"), "error");
      editBookSaveRunning = false;
      if (els.editBookCancel) els.editBookCancel.disabled = false;
      if (els.editBookSave) els.editBookSave.disabled = false;
      return;
    }
    Object.assign(customText, nextCustomText);
    if (!window.__qtBridge) customText.text = cleanText;
    bookTexts.set(targetBookId, cleanText);
  } else if (userBook) {
    Object.assign(userBook, {
      title: cleanTitle,
      author: els.editBookAuthor.value.trim(),
      tags: parseTagList(els.editBookTags?.value),
      coverDataUrl: pendingEditCoverDataUrl,
      level: els.editBookLevel?.value || "",
      updatedAt: new Date().toISOString()
    });
  }
  invalidateBookId(targetBookId);

  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("save edited book failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("edit book recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    editBookSaveRunning = false;
    if (els.editBookCancel) els.editBookCancel.disabled = false;
    if (els.editBookSave) els.editBookSave.disabled = false;
    return;
  }
  renderLibrary();
  if (state.currentTextId === targetBookId) renderReader();
  showToast(t("toast.textSaved"));
  editBookOriginalValues = null;
  if (els.editBookText) els.editBookText.readOnly = false;
  els.editBookDialog.close();
  editingBookId = null;
  editingBookKind = null;
  editBookSaveRunning = false;
  if (els.editBookCancel) els.editBookCancel.disabled = false;
  if (els.editBookSave) els.editBookSave.disabled = false;
}

export async function pasteImageToEditBook(file: File): Promise<void> {
  if (!editingBookId) return;
  const targetBookId = editingBookId;
  const generation = editBookGeneration;
  const ext = file.type.split("/")[1] || "png";
  const imgName = `img_${Date.now()}.${ext}`;

  const reader = new FileReader();
  reader.onload = async () => {
    if (generation !== editBookGeneration || editingBookId !== targetBookId) return;
    const base64Data = typeof reader.result === "string" ? reader.result : "";
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
          body: JSON.stringify({ book_id: targetBookId, img_name: imgName, base64_data: base64Data })
        });
      } catch(e) { console.warn("Image upload failed", e); }
    }
  };
  reader.readAsDataURL(file);
}
