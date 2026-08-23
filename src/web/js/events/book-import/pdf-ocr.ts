// PDF text-layer / whole-book OCR import plus desktop image-OCR import,
// including the Android PDF renderer bridge glue.
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import { showToast } from "../../toast.js";
import { isAndroidPlatform } from "../../platform.js";
import { effectiveLearningLanguage } from "../../translator-preferences.js";
import { httpPost } from "../../http.js";
import {
  el,
  slugFromFileName,
  setImportLoading,
  waitForUiPaint,
  MAX_DESKTOP_OCR_IMAGE_BYTES,
  isOcrImportRunning,
  setOcrImportRunning,
} from "./shared.js";
import {
  readFileAsBase64,
  parseAndroidPdfRenderResponse,
  getAndroidPdfRendererBridge,
  renderAndSaveAndroidPdfPages,
  startAndroidPdfProgress,
  startOcrProgress,
  stopAndroidPdfProgress,
  stopOcrProgress,
  updateAndroidPdfProgress,
  isAndroidPdfRenderCancelled,
  setAndroidPdfRenderCancelled,
  MAX_DESKTOP_PDF_BYTES,
  MAX_POCKET_PDF_BYTES,
  MAX_POCKET_PDF_RENDER_PAGES,
  type PdfImportResponse,
} from "./ocr-progress.js";
import { isImageOcrAvailable } from "../../platform.js";
import { validatedOcrImageFormat } from "../../ocr-image-format.js";
import { titleFromImportedFileName } from "../../subtitles.js";
import { importCustomText } from "../../book-actions.js";
import { deleteStoredText } from "../../store-bridge.js";

const POCKET_PDF_SCAN_ERROR = "PDF_TEXT_LAYER_EMPTY";

export function confirmWholeBookOcr(): Promise<boolean> {
  let dialog = document.querySelector<HTMLDialogElement>("#ocr-whole-book-confirm");
  if (dialog && (
    !dialog.querySelector("h2")
    || !dialog.querySelector("p")
    || !dialog.querySelector('[data-action="cancel"]')
    || !dialog.querySelector('[data-action="confirm"]')
  )) {
    // A stale/partially-restored dialog must not make the Promise executor
    // throw before it can settle. Rebuild the complete dialog instead.
    dialog.remove();
    dialog = null;
  }
  dialog ||= (() => {
    const next = document.createElement("dialog");
    next.id = "ocr-whole-book-confirm";
    next.className = "panel ocr-confirm-dialog";
    next.setAttribute("aria-labelledby", "ocr-whole-book-confirm-title");
    next.innerHTML = `
      <div class="panel-header"><h2 id="ocr-whole-book-confirm-title">${t("import.ocrWholeBookTitle")}</h2></div>
      <div class="ocr-confirm-body">
        <p class="muted-copy">${t("import.ocrWholeBookConfirm")}</p>
        <div class="ocr-confirm-actions">
          <button class="secondary-button" type="button" data-action="cancel">${t("import.ocrWholeBookCancel")}</button>
          <button class="primary-button" type="button" data-action="confirm">${t("import.ocrWholeBookStart")}</button>
        </div>
      </div>`;
    document.body.appendChild(next);
    return next;
  })();
  const heading = dialog.querySelector<HTMLElement>("h2");
  const copy = dialog.querySelector<HTMLElement>("p");
  const cancelButton = dialog.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  const confirmButton = dialog.querySelector<HTMLButtonElement>('[data-action="confirm"]');
  if (!heading || !copy || !cancelButton || !confirmButton) {
    dialog.remove();
    return Promise.resolve(false);
  }
  heading.textContent = t("import.ocrWholeBookTitle");
  copy.textContent = t("import.ocrWholeBookConfirm");
  cancelButton.textContent = t("import.ocrWholeBookCancel");
  confirmButton.textContent = t("import.ocrWholeBookStart");

  return new Promise<boolean>((resolve) => {
    const finish = (accepted: boolean) => {
      if (dialog.open) dialog.close();
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", backdrop);
      cancelButton.removeEventListener("click", cancel);
      confirmButton.removeEventListener("click", confirm);
      dialog.remove();
      resolve(accepted);
    };
    const cancel = (event?: Event) => { event?.preventDefault(); finish(false); };
    const confirm = () => finish(true);
    const backdrop = (event: MouseEvent) => { if (event.target === dialog) cancel(); };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", backdrop);
    cancelButton.addEventListener("click", cancel);
    confirmButton.addEventListener("click", confirm);
    dialog.showModal();
  });
}

function showPocketPdfScanDialog(): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("#pocket-pdf-scan-warning") || (() => {
    const next = document.createElement("dialog");
    next.id = "pocket-pdf-scan-warning";
    next.className = "panel ocr-confirm-dialog";
    next.setAttribute("aria-labelledby", "pocket-pdf-scan-warning-title");
    next.innerHTML = `
      <div class="panel-header"><h2 id="pocket-pdf-scan-warning-title"></h2></div>
      <div class="ocr-confirm-body">
        <p class="muted-copy"></p>
        <div class="ocr-confirm-actions">
          <button class="primary-button" type="button" data-action="close"></button>
        </div>
      </div>`;
    document.body.appendChild(next);
    return next;
  })();
  dialog.querySelector("h2").textContent = t("import.pdfPocketScanTitle");
  dialog.querySelector("p").textContent = t("import.pdfPocketScanBody");
  dialog.querySelector('[data-action="close"]').textContent = t("reader.close");

  return new Promise<void>((resolve) => {
    const finish = (event?: Event) => {
      event?.preventDefault();
      dialog.close();
      dialog.removeEventListener("cancel", finish);
      closeButton.removeEventListener("click", finish);
      resolve();
    };
    const closeButton = dialog.querySelector<HTMLButtonElement>('[data-action="close"]');
    dialog.addEventListener("cancel", finish);
    closeButton.addEventListener("click", finish);
    dialog.showModal();
  });
}

async function importPdfFile(file: File): Promise<boolean> {
  if (isOcrImportRunning()) throw new Error(t("toast.pdfImportBusy"));
  setOcrImportRunning(true);
  try {
    return await runPdfImport(file);
  } catch (error) {
    if (error?.message === POCKET_PDF_SCAN_ERROR) {
      await showPocketPdfScanDialog();
      return false;
    }
    throw error;
  } finally {
    setOcrImportRunning(false);
  }
}

async function runPdfImport(file: File): Promise<boolean> {
  const androidPdfOverlay = isAndroidPlatform();
  if (!window.__qtBridge && !androidPdfOverlay) {
    throw new Error(t("toast.pdfOcrRequiresApp"));
  }
  const maxBytes = androidPdfOverlay ? MAX_POCKET_PDF_BYTES : MAX_DESKTOP_PDF_BYTES;
  if (Number(file?.size) > maxBytes) {
    throw new Error(t("toast.pdfTooLarge", { mb: Math.floor(maxBytes / (1024 * 1024)) }));
  }
  if (!androidPdfOverlay && !await confirmWholeBookOcr()) return false;
  const profile = state.preferences.learningLanguage || "en";
  const lang = effectiveLearningLanguage(state.preferences);
  const id = `${profile}-pdf-ocr-${slugFromFileName(file.name)}-${Date.now()}`;
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  let cancelled = false;
  let requestStarted = false;
  setImportLoading(true, androidPdfOverlay ? "import.parsingPdfTextLayer" : "import.parsingPdfOcr");
  if (!androidPdfOverlay) {
    startOcrProgress("import.parsingPdfOcr", "import.ocrWholeBookStatus", () => {
      cancelled = true;
      controller.abort();
      if (requestStarted) {
        void httpPost("/__import/ocr/cancel", { job_id: jobId })
          .catch((error) => console.warn("PDF OCR cancellation request failed", error));
      }
    });
  }
  try {
    if (!androidPdfOverlay) await waitForUiPaint();
    let data = null;
    const params = new URLSearchParams({
      book_id: id,
      job_id: jobId,
      filename: file.name || t("import.importedPdfTitle"),
      lang,
      max_pages: "0"
    });
    requestStarted = true;
    const response = await fetch(`/__import/pdf_ocr/raw?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-WH-Token": window.WH_TOKEN || "" },
      signal: controller.signal,
      body: file
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      if (message.trim() === POCKET_PDF_SCAN_ERROR) {
        throw new Error(POCKET_PDF_SCAN_ERROR);
      }
      throw new Error(message || `HTTP ${response.status}`);
    }
    const imported = await response.json() as PdfImportResponse;
    const pages = Array.isArray(imported.pages) ? imported.pages : [];
    const text = imported.text || pages.map((page) => page.text || "").join("\n\n").trim();
    if (!text) throw new Error(t("toast.pdfOcrNoText"));
    const pageCount = imported.pageCount || pages.length;
    const ocrEngine = imported.ocrEngine || "PaddleOCR";
    const hasOverlayPages = pages.length > 0;
    if (androidPdfOverlay && hasOverlayPages) {
      setAndroidPdfRenderCancelled(false);
      startAndroidPdfProgress(Math.min(pages.length, MAX_POCKET_PDF_RENDER_PAGES), () => {
        setAndroidPdfRenderCancelled(true);
        cancelled = true;
      });
      data = await readFileAsBase64(file);
      await renderAndSaveAndroidPdfPages(data, id, pages);
      stopAndroidPdfProgress();
    }
    const blurb = androidPdfOverlay
      ? t("import.pdfTextLayerBlurb", { pages: pageCount })
      : hasOverlayPages
        ? imported.truncated
          ? t("import.pdfOcrBlurbTruncated", { processed: pages.length, total: pageCount, engine: ocrEngine })
          : t("import.pdfOcrBlurb", { pages: pages.length, engine: ocrEngine })
        : t("import.pdfTextLayerBlurb", { pages: pageCount });
    const importedId = await importCustomText(imported.title || titleFromImportedFileName(file.name || t("import.importedPdfTitle")), text, {
      id,
      blurb,
      coverDataUrl: hasOverlayPages && pages[0]?.imageName ? `/__media?book=${encodeURIComponent(id)}&img=${encodeURIComponent(pages[0].imageName)}` : "",
      pdfOcrPages: hasOverlayPages ? pages : undefined,
      pdfOcrEngine: hasOverlayPages ? ocrEngine : "",
      pdfOcrPageCount: hasOverlayPages ? pageCount : 0,
      experimental: hasOverlayPages
    });
    if (!importedId) throw new Error(t("toast.importFailed"));
    return true;
  } catch (error) {
    await deleteStoredText(id).catch((cleanupError) => {
      console.warn("Failed to clean incomplete PDF import", cleanupError);
    });
    if (cancelled) {
      showToast(t("import.ocrCancelled"));
      return false;
    }
    throw error;
  } finally {
    // The render loop can throw (bridge error, cancel, network) — the
    // progress interval must never outlive the import (timer leak).
    stopAndroidPdfProgress();
    stopOcrProgress();
    setImportLoading(false);
  }
}

async function importOcrImageFile(file: File): Promise<boolean> {
  if (!isImageOcrAvailable() || !window.__qtBridge) {
    throw new Error(t("toast.imageOcrRequiresApp"));
  }
  if (isOcrImportRunning()) throw new Error(t("toast.pdfImportBusy"));
  const format = validatedOcrImageFormat(file);
  if (!format) throw new Error(t("toast.imageOcrUnsupported"));
  if (file.size > MAX_DESKTOP_OCR_IMAGE_BYTES) {
    throw new Error(t("toast.imageTooLarge", { mb: Math.floor(MAX_DESKTOP_OCR_IMAGE_BYTES / (1024 * 1024)) }));
  }
  setOcrImportRunning(true);
  const profile = state.preferences.learningLanguage || "en";
  const id = `${profile}-image-ocr-${slugFromFileName(file.name)}-${Date.now()}`;
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  let cancelled = false;
  let requestStarted = false;
  setImportLoading(true, "import.parsingImageOcr");
  startOcrProgress("import.parsingImageOcr", "import.ocrImageStatus", () => {
    cancelled = true;
    controller.abort();
    if (requestStarted) {
      void httpPost("/__import/ocr/cancel", { job_id: jobId })
        .catch((error) => console.warn("Image OCR cancellation request failed", error));
    }
  });
  try {
    await waitForUiPaint();
    const params = new URLSearchParams({
      book_id: id,
      job_id: jobId,
      filename: file.name || t("import.importedImageTitle"),
      lang: effectiveLearningLanguage(state.preferences)
    });
    requestStarted = true;
    const response = await httpPost(`/__import/image_ocr/raw?${params}`, file, {
      headers: { "Content-Type": format.contentType },
      signal: controller.signal
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `HTTP ${response.status}`);
    }
    const imported = await response.json() as PdfImportResponse;
    const pages = Array.isArray(imported.pages) ? imported.pages : [];
    const text = imported.text || pages.map((page) => page.text || "").join("\n\n").trim();
    if (!text || pages.length !== 1 || !pages[0]?.imageName) {
      throw new Error(t("toast.imageOcrNoText"));
    }
    const ocrEngine = imported.ocrEngine || "PaddleOCR";
    const importedId = await importCustomText(
      imported.title || titleFromImportedFileName(file.name || t("import.importedImageTitle")),
      text,
      {
        id,
        blurb: t("import.imageOcrBlurb", { engine: ocrEngine }),
        coverDataUrl: `/__media?book=${encodeURIComponent(id)}&img=${encodeURIComponent(pages[0].imageName)}`,
        pdfOcrPages: pages,
        pdfOcrEngine: ocrEngine,
        pdfOcrPageCount: 1,
        experimental: true
      }
    );
    if (!importedId) throw new Error(t("toast.importFailed"));
    return true;
  } catch (error) {
    await deleteStoredText(id).catch((cleanupError) => {
      console.warn("Failed to clean incomplete image OCR import", cleanupError);
    });
    if (cancelled) {
      showToast(t("import.ocrCancelled"));
      return false;
    }
    throw error;
  } finally {
    setOcrImportRunning(false);
    stopOcrProgress();
    setImportLoading(false);
  }
}

export { importPdfFile, importOcrImageFile };
