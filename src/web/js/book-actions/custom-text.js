/**
 * Custom text import/removal and slug helper.
 */
import { state, saveState, clearLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { bookTexts } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { parseTagList } from "../utils.js";
import { t } from "../i18n.js";
import { render, ensureCurrentText } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { openBook } from "./index.js";
import { forgetArchivedBook } from "./library-ops.js";

export function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export async function importCustomText(title, text, meta = {}, openAfterImport = true) {
  const cleanTitle = title.trim();
  const cleanText = text.trim();
  if (!cleanTitle || !cleanText) return null;

  const now = new Date().toISOString();
  const slug = slugify(cleanTitle);
  const id = meta.id || `${state.preferences.learningLanguage}-custom-${slug || Date.now()}`;
  const customText = {
    id: id,
    title: cleanTitle,
    lang: state.preferences.learningLanguage,
    author: (meta.author || "").trim(),
    source: meta.source || t("reader.localSource"),
    level: meta.level || "",
    blurb: (meta.blurb || "").trim(),
    tags: parseTagList(meta.tags),
    sourceUrl: meta.sourceUrl || "",
    textUrl: meta.textUrl || "",
    coverDataUrl: meta.coverDataUrl || "",
    pdfOcrPages: Array.isArray(meta.pdfOcrPages) ? meta.pdfOcrPages : undefined,
    pdfOcrEngine: meta.pdfOcrEngine || "",
    pdfOcrPageCount: meta.pdfOcrPageCount || 0,
    experimental: Boolean(meta.experimental),
    createdAt: meta.createdAt || now,
    updatedAt: now
  };

  if (!window.__qtBridge) {
    customText.text = cleanText; // Save locally if no backend
  }

  bookTexts.set(id, cleanText);
  invalidateBookId(id);

  const idx = state.customTexts.findIndex(item => String(item.id) === String(customText.id));
  if (idx !== -1) state.customTexts.splice(idx, 1);
  state.customTexts.push(customText);

  if (window.__qtBridge) {
    const payload = { ...customText, text: cleanText };
    try {
      await fetch("/__store/upsert_text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify(payload)
      });
    } catch(e) { console.warn("upsert_text failed", e); }
  }

  saveState();
  showToast(t("toast.textAdded"));
  if (openAfterImport) {
    await openBook(id);
  } else {
    renderLibrary();
  }
  return id;
}

export function removeCustomText(id) {
  const idx = state.customTexts.findIndex(t => t.id === id);
  if (idx === -1) return;
  forgetArchivedBook(id);
  state.customTexts.splice(idx, 1);
  invalidateBookId(id);
  if (state.currentTextId === id) {
    state.currentTextId = null;
    state.selectedWord = null;
    ensureCurrentText();
  }
  clearLastReadTextId(id);

  if (window.__qtBridge) {
    fetch("/__store/delete_text", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ id: id })
    }).catch(e => console.warn("delete_text failed", e));
  }

  saveState();
  render();
  showToast(t("toast.textRemoved"));
}
