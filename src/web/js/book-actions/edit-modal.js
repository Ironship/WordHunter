/**
 * Edit-book modal: module state, dirty tracking, open/cancel/save, image paste.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { showToast } from "../toast.js";
import { bookTexts, findBookById } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { formatTagList, parseTagList } from "../utils.js";
import { t } from "../i18n.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../views/reader.js";

let editingBookId = null;
export let pendingEditCoverDataUrl = null;
let editBookOriginalValues = null;

export function setPendingEditCoverDataUrl(url) {
  pendingEditCoverDataUrl = url;
}

export function isEditBookDirty() {
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

export function cancelEditBook() {
  editBookOriginalValues = null;
  pendingEditCoverDataUrl = null;
  editingBookId = null;
  els.editBookDialog.close();
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
  invalidateBookId(editingBookId);

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
  editBookOriginalValues = null;
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
