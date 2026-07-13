/**
 * Custom text import/removal and slug helper.
 */
import { state, clearLastReadTextId } from "../state.js";
import { showToast } from "../toast.js";
import { bookTexts, clearBookTextCache } from "../books.js";
import { invalidateBookId } from "../vocab-index-client.js";
import { parseTagList } from "../utils.js";
import { t } from "../i18n.js";
import { render, ensureCurrentText } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "../bridge-commit.js";
import { deleteStoredText, upsertStoredText } from "../store-bridge.js";
import {
  clearCurrentBookSelectionIfMatches,
  findCustomText,
  removeCustomTextFromActiveProfile,
  upsertCustomText
} from "./profile-library.js";
import { buildPdfDocumentText, effectivePdfPageText, reconcilePdfPageWords } from "../reader/pdf-page-text.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

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
  const existingText = findCustomText(id, { coerce: true });
  const pdfOcrPages = Array.isArray(meta.pdfOcrPages) ? meta.pdfOcrPages : existingText?.pdfOcrPages;
  const hasPdfOcrPages = Array.isArray(pdfOcrPages) && pdfOcrPages.length > 0;
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
    coverDataUrl: meta.coverDataUrl || existingText?.coverDataUrl || "",
    pdfOcrPages: hasPdfOcrPages ? pdfOcrPages : undefined,
    pdfOcrEngine: meta.pdfOcrEngine || (hasPdfOcrPages ? existingText?.pdfOcrEngine || "" : ""),
    pdfOcrPageCount: meta.pdfOcrPageCount || (hasPdfOcrPages ? existingText?.pdfOcrPageCount || 0 : 0),
    experimental: Boolean(meta.experimental || (hasPdfOcrPages && existingText?.experimental)),
    createdAt: meta.createdAt || now,
    updatedAt: now
  };

  if (!window.__qtBridge) {
    customText.text = cleanText; // Save locally if no backend
  }

  if (window.__qtBridge) {
    try {
      await upsertStoredText({ ...customText, text: cleanText });
    } catch (error) {
      console.warn("upsert_text failed", error);
      showToast(t("toast.importFailed"), "error");
      return null;
    }
  }

  bookTexts.set(id, cleanText);
  invalidateBookId(id);
  upsertCustomText(customText);

  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("custom text profile save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("custom text recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return null;
  }
  showToast(t("toast.textAdded"));
  if (openAfterImport) {
    const { openBook } = await import("../book-actions.js");
    await openBook(id);
  } else {
    renderLibrary();
  }
  return id;
}

export async function updatePdfOcrPageText(id, pageIndex, correctedText, options = {}) {
  const existing = findCustomText(id, { coerce: true });
  if (!existing || !Array.isArray(existing.pdfOcrPages) || !existing.pdfOcrPages[pageIndex]) return false;
  if (Object.hasOwn(options, "expectedUpdatedAt")
    && (existing.updatedAt || null) !== (options.expectedUpdatedAt || null)) return false;

  const pages = existing.pdfOcrPages.map((page, index) => {
    if (index !== pageIndex) return { ...page };
    const next = { ...page };
    const corrected = String(correctedText || "").trim();
    const originalPage = { ...page };
    delete originalPage.correctedText;
    const original = effectivePdfPageText(originalPage);
    next.words = reconcilePdfPageWords(
      Array.isArray(page.words) ? page.words : [],
      corrected,
      effectiveLearningLanguage(state.preferences),
      state.preferences.wordDetectionAlgorithm || "modern"
    );
    if (corrected === original) delete next.correctedText;
    else next.correctedText = corrected;
    return next;
  });
  const text = buildPdfDocumentText(pages);

  const updated = {
    ...existing,
    pdfOcrPages: pages,
    updatedAt: new Date().toISOString()
  };
  try {
    if (window.__qtBridge) await upsertStoredText({ ...updated, text }, { allowEmpty: true });
  } catch (error) {
    console.warn("PDF OCR correction upsert failed", error);
    return false;
  }

  if (!window.__qtBridge) updated.text = text;
  bookTexts.set(id, text);
  invalidateBookId(id);
  upsertCustomText(updated);
  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("PDF OCR correction profile save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("PDF OCR correction recovery reload failed", reloadError);
    });
    const recovered = findCustomText(id, { coerce: true });
    return effectivePdfPageText(recovered?.pdfOcrPages?.[pageIndex]) === String(correctedText || "").trim();
  }
  return true;
}

export async function removeCustomText(id) {
  const existing = findCustomText(id);
  if (!existing) return;
  if (window.__qtBridge) {
    try {
      await deleteStoredText(id);
    } catch (error) {
      console.warn("delete_text failed", error);
      showToast(t("toast.syncUnavailable"), "error");
      return;
    }
  }

  const textObj = removeCustomTextFromActiveProfile(id);
  if (!textObj) return;
  clearBookTextCache(id);
  if (clearCurrentBookSelectionIfMatches(id)) ensureCurrentText();
  clearLastReadTextId(id);

  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("delete_text profile save failed", error);
    if (window.__qtBridge) {
      await reloadBridgeSnapshot().catch((reloadError) => {
        console.warn("delete_text recovery reload failed", reloadError);
      });
    }
    showToast(t("toast.syncUnavailable"), "error");
    return;
  }

  render();
  showToast(t("toast.textRemoved"));
}
