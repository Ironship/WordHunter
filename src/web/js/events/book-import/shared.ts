// Shared import-panel state, small helpers and loading UI used by the
// book-import submodules (split out of the former monolithic book-import.ts).
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import {
  MAX_POCKET_PDF_BYTES,
  MAX_DESKTOP_PDF_BYTES,
  ANDROID_PDF_RENDER_MAX_BASE64_MB,
} from "./ocr-progress.js";
import { setElementBusy } from "../../loading.js";
import { titleFromImportedFileName } from "../../subtitles.js";

type ImportMeta = {
  author?: string;
  tags?: string;
  level?: string;
  source?: string;
  sourceUrl?: string;
  textUrl?: string;
  coverDataUrl?: string | null;
};

type ClipboardEventWithOriginal = ClipboardEvent & {
  originalEvent?: ClipboardEvent;
};

let pendingCoverDataUrl: string | null = "";
let pendingImportMeta: ImportMeta = {};

const MAX_DESKTOP_OCR_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_DESKTOP_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_POCKET_IMPORT_FILE_BYTES = 24 * 1024 * 1024;
const MAX_SERIALIZED_IMPORT_TEXT_BYTES = 96 * 1024 * 1024;
let ocrImportRunning = false;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Builds the library import panel (port of #127 P2: the static <aside> moved
 * from index.html into this renderer). Idempotent; appends into the library
 * workspace grid so the panel keeps its grid column position.
 */

function resetCoverPreview() {
  pendingCoverDataUrl = "";
  const coverImg = el<HTMLImageElement>("import-cover-img");
  if (coverImg) coverImg.src = "";
  const coverPreview = el<HTMLElement>("import-cover-preview");
  if (coverPreview) coverPreview.hidden = true;
  const cover = el<HTMLInputElement>("import-cover");
  if (cover) cover.value = "";
  const dropzone = document.getElementById("import-cover-dropzone");
  if (dropzone) dropzone.style.display = "flex";
}

function setImportCoverPreview(dataUrl: string): void {
  pendingCoverDataUrl = dataUrl || "";
  const coverImg = el<HTMLImageElement>("import-cover-img");
  if (coverImg) coverImg.src = pendingCoverDataUrl;
  const coverPreview = el<HTMLElement>("import-cover-preview");
  if (coverPreview) coverPreview.hidden = !pendingCoverDataUrl;
  const dropzone = document.getElementById("import-cover-dropzone");
  if (dropzone) dropzone.style.display = pendingCoverDataUrl ? "none" : "flex";
}

function clearPendingImportMeta() {
  pendingImportMeta = {};
}

function isEbookFile(file: File | null | undefined): boolean {
  return /\.(epub|mobi|azw|azw3)$/i.test(file?.name || "");
}

function isPdfFile(file: File | null | undefined): boolean {
  return file?.type === "application/pdf" || /\.pdf$/i.test(file?.name || "");
}

function safeImportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/PaddleOCR did not find readable text in this image/i.test(message)) return t("toast.imageOcrNoText");
  if (/Image is too large/i.test(message)) {
    return t("toast.imageTooLarge", { mb: Math.floor(MAX_DESKTOP_OCR_IMAGE_BYTES / (1024 * 1024)) });
  }
  if (/unsupported.*image|image.*does not match/i.test(message)) return t("toast.imageOcrUnsupported");
  if (/Image OCR requires the bundled PaddleOCR component/i.test(message)) return t("toast.imageOcrRequiresApp");
  if (/yt-dlp|\[youtube\]|video (?:unavailable|not found)|private video|sign in to confirm/i.test(message)) return t("import.youtubeError");
  const localizedMessages = new Set([
    t("toast.pdfImportBusy"),
    t("toast.pdfOcrRequiresApp"),
    t("toast.pdfTooLarge", { mb: Math.floor(MAX_POCKET_PDF_BYTES / (1024 * 1024)) }),
    t("toast.pdfTooLarge", { mb: Math.floor(MAX_DESKTOP_PDF_BYTES / (1024 * 1024)) }),
    t("toast.pdfTooLarge", { mb: ANDROID_PDF_RENDER_MAX_BASE64_MB }),
    t("toast.pdfOcrNoText"),
    t("toast.imageOcrRequiresApp"),
    t("toast.imageOcrNoText"),
    t("toast.imageOcrUnsupported"),
    t("toast.imageTooLarge", { mb: Math.floor(MAX_DESKTOP_OCR_IMAGE_BYTES / (1024 * 1024)) }),
    t("toast.importFailed"),
    t("toast.ebookRequiresApp"),
    t("toast.importedEbookEmpty"),
    t("toast.importedFileEmpty"),
    t("toast.importFileTooLarge", { mb: Math.floor(MAX_POCKET_IMPORT_FILE_BYTES / (1024 * 1024)) }),
    t("toast.importFileTooLarge", { mb: Math.floor(MAX_DESKTOP_IMPORT_FILE_BYTES / (1024 * 1024)) })
  ]);
  return localizedMessages.has(message) ? message : t("toast.fileError");
}

function slugFromFileName(name: string): string | number {
  const base = titleFromImportedFileName(name || t("import.importedPdfTitle"));
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || Date.now();
}

function setImportLoading(visible: boolean, messageKey = "import.parsingEbook"): void {
  let overlay = document.getElementById("import-loading");
  if (visible) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "import-loading";
      overlay.className = "section-loading";
      const form = document.getElementById("import-form");
      if (form) form.style.position = "relative", form.appendChild(overlay);
    }
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-atomic", "true");
    overlay.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="muted-copy">${t(messageKey)}</p>`;
    overlay.hidden = false;
  } else {
    const ov = document.getElementById("import-loading");
    if (ov) ov.hidden = true;
  }
  setElementBusy(document.getElementById("import-form"), visible);
}

function waitForUiPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}


// --- cross-submodule surface -------------------------------------------------
export {
  el,
  resetCoverPreview,
  setImportCoverPreview,
  clearPendingImportMeta,
  isEbookFile,
  isPdfFile,
  safeImportErrorMessage,
  slugFromFileName,
  setImportLoading,
  waitForUiPaint,
  MAX_DESKTOP_OCR_IMAGE_BYTES,
  MAX_DESKTOP_IMPORT_FILE_BYTES,
  MAX_POCKET_IMPORT_FILE_BYTES,
  MAX_SERIALIZED_IMPORT_TEXT_BYTES,
};
export type { ImportMeta, ClipboardEventWithOriginal };

// Mutable module state is owned here; ESM imported bindings are read-only, so
// sibling submodules mutate through these accessors instead of direct assignment.
export function getPendingCoverDataUrl(): string | null {
  return pendingCoverDataUrl;
}
export function setPendingCoverDataUrl(value: string | null): void {
  pendingCoverDataUrl = value;
}
export function getPendingImportMeta(): ImportMeta {
  return pendingImportMeta;
}
export function setPendingImportMeta(value: ImportMeta): void {
  pendingImportMeta = value;
}
export function isOcrImportRunning(): boolean {
  return ocrImportRunning;
}
export function setOcrImportRunning(value: boolean): void {
  ocrImportRunning = value;
}
