// OCR / Android PDF-render progress overlays with cancel wiring.
import { t } from "../../i18n.js";
import { httpPost } from "../../http.js";
import { isAndroidPlatform } from "../../platform.js";
import { el, waitForUiPaint } from "./shared.js";

type AndroidPdfRenderResponse = {
  success: boolean;
  error?: string;
  dataUrl?: string;
};

type PdfOcrPage = WhRecord & {
  text?: string;
  imageName?: string;
};

type PdfImportResponse = {
  title?: string;
  text?: string;
  pages?: PdfOcrPage[];
  pageCount?: number;
  ocrEngine?: string;
  truncated?: boolean;
};

export const MAX_DESKTOP_PDF_BYTES = 256 * 1024 * 1024;
export const MAX_POCKET_PDF_BYTES = 32 * 1024 * 1024;
// The native Pocket bridge rejects base64 payloads above this cap BEFORE any
// decode (see ANDROID_PDF_MAX_BASE64_DECODED in MainActivity.kt), so a huge
// string is never materialized on the Java heap. Guard here as well, before
// the payload crosses the bridge at all.
export const ANDROID_PDF_RENDER_MAX_BASE64_MB = 64;

export const ANDROID_PDF_RENDER_MAX_BASE64_ENCODED = ANDROID_PDF_RENDER_MAX_BASE64_MB * 1024 * 1024 * 4 / 3 + 4;
/**
 * Rendering each PDF page synchronously on the JavaBridge stalls the JS
 * renderer ~100–500 ms per page. A 2000-page book would freeze the UI for
 * dozens of minutes, so Android overlay rendering is capped here (and the
 * page loop yields between pages so the spinner keeps painting).
 */
export const MAX_POCKET_PDF_RENDER_PAGES = 300;
// Render at the screen width (device pixels) so small phones do not
// allocate 1400px bitmaps, clamped to the native renderer range.

function pdfRenderWidth(): number {
  const width = typeof window !== "undefined" && window.devicePixelRatio
    ? Math.round(window.innerWidth * window.devicePixelRatio)
    : 1400;
  return Math.min(2400, Math.max(512, width));
}

async function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read file")), { once: true });
    reader.readAsDataURL(file);
  });
}

function parseAndroidPdfRenderResponse(raw: unknown, fallbackMessage: string): AndroidPdfRenderResponse {
  let payload: AndroidPdfRenderResponse;
  try {
    payload = JSON.parse(String(raw || "")) as AndroidPdfRenderResponse;
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!payload?.success) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
}

function getAndroidPdfRendererBridge(): WhAndroidBridge | null {
  const bridge = window.WordHunterAndroid;
  if (!bridge || typeof bridge.beginPdfRender !== "function" || typeof bridge.renderPdfPage !== "function") {
    return null;
  }
  return bridge;
}

async function renderAndSaveAndroidPdfPages(data: string, bookId: string, pages: PdfOcrPage[]): Promise<void> {
  if (!isAndroidPlatform() || !pages.length) return;
  const bridge = getAndroidPdfRendererBridge();
  if (!bridge) throw new Error(t("toast.pdfOcrRequiresApp"));

  const limitedPages = pages.slice(0, MAX_POCKET_PDF_RENDER_PAGES);
  if (data.length > ANDROID_PDF_RENDER_MAX_BASE64_ENCODED) {
    throw new Error(t("toast.pdfTooLarge", { mb: ANDROID_PDF_RENDER_MAX_BASE64_MB }));
  }
  const sessionId = `wh-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  parseAndroidPdfRenderResponse(
    bridge.beginPdfRender(sessionId, data),
    t("toast.pdfOcrNoText")
  );
  try {
    for (let index = 0; index < limitedPages.length; index += 1) {
      if (androidPdfRenderCancelled) throw new Error("android pdf render cancelled");
      // Yield between synchronous bridge renders so the UI keeps painting
      // (spinner, progress) instead of freezing for the whole import.
      await waitForUiPaint();
      updateAndroidPdfProgress(index + 1, limitedPages.length);
      const page = limitedPages[index];
      const rendered = parseAndroidPdfRenderResponse(
        bridge.renderPdfPage(sessionId, index, pdfRenderWidth()),
        t("toast.pdfOcrNoText")
      );
      if (!rendered.dataUrl || !page?.imageName) {
        throw new Error(t("toast.pdfOcrNoText"));
      }
      const response = await httpPost("/__book/image", {
        book_id: bookId,
        img_name: page.imageName,
        base64_data: rendered.dataUrl,
        pending_import: true
      }, { timeoutMs: 30_000 });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `HTTP ${response.status}`);
      }
    }
  } finally {
    if (typeof bridge.endPdfRender === "function") bridge.endPdfRender(sessionId);
  }
}

let _ocrTimerHandle: number | null = null;
let androidPdfRenderCancelled = false;
export function isAndroidPdfRenderCancelled(): boolean { return androidPdfRenderCancelled; }
export function setAndroidPdfRenderCancelled(v: boolean): void { androidPdfRenderCancelled = v; }
let _androidPdfProgressTimer: number | null = null;

function startAndroidPdfProgress(total: number, onCancel: () => void): void {
  stopOcrProgress();
  const overlay = document.getElementById("import-loading");
  if (!overlay) return;
  const startedAt = Date.now();
  overlay.innerHTML = `
    <div class="ocr-progress-card">
      <div class="ocr-progress-document" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
        <i class="ocr-progress-scan-line"></i>
      </div>
      <div class="ocr-progress-copy">
        <p id="ocr-progress-text"></p>
        <p class="muted-copy ocr-progress-eta" id="ocr-progress-eta" aria-hidden="true"></p>
      </div>
      <div class="ocr-progress-bar" aria-hidden="true"><div class="ocr-progress-bar-fill"></div></div>
      <button class="secondary-button" type="button" id="ocr-cancel">${t("import.ocrCancel")}</button>
    </div>
  `;
  const textEl = () => overlay.querySelector<HTMLElement>("#ocr-progress-text");
  const etaEl = () => overlay.querySelector<HTMLElement>("#ocr-progress-eta");
  const fillEl = () => overlay.querySelector<HTMLElement>(".ocr-progress-bar-fill");
  const fmt = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (textEl()) textEl().textContent = t("import.pdfPageRenderProgress", { processed: 0, total });
    if (etaEl()) etaEl().textContent = t("import.pdfPageRenderStatus", { elapsed: fmt(elapsed) });
  };
  overlay.querySelector<HTMLButtonElement>("#ocr-cancel")?.addEventListener("click", (event) => {
    (event.currentTarget as HTMLButtonElement).disabled = true;
    if (textEl()) textEl().textContent = t("import.ocrCancelling");
    stopOcrProgress();
    onCancel();
  });
  tick();
  _androidPdfProgressTimer = setInterval(tick, 1000);
}

function updateAndroidPdfProgress(processed: number, total: number): void {
  const overlay = document.getElementById("import-loading");
  if (!overlay) return;
  const textEl = overlay.querySelector<HTMLElement>("#ocr-progress-text");
  const fillEl = overlay.querySelector<HTMLElement>(".ocr-progress-bar-fill");
  if (textEl) textEl.textContent = t("import.pdfPageRenderProgress", { processed, total });
  if (fillEl && total > 0) {
    fillEl.style.width = `${Math.round((processed / total) * 100)}%`;
  }
}

function stopAndroidPdfProgress(): void {
  if (_androidPdfProgressTimer !== null) {
    clearInterval(_androidPdfProgressTimer);
    _androidPdfProgressTimer = null;
  }
}

function startOcrProgress(messageKey: string, statusKey: string, onCancel: () => void): void {
  stopOcrProgress();
  const overlay = document.getElementById("import-loading");
  if (!overlay) return;
  const startedAt = Date.now();
  overlay.innerHTML = `
    <div class="ocr-progress-card">
      <div class="ocr-progress-document" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
        <i class="ocr-progress-scan-line"></i>
      </div>
      <div class="ocr-progress-copy">
        <p id="ocr-progress-text"></p>
        <p class="muted-copy ocr-progress-eta" id="ocr-progress-eta" aria-hidden="true"></p>
      </div>
      <div class="ocr-progress-bar" aria-hidden="true"><div class="ocr-progress-bar-fill"></div></div>
      <button class="secondary-button" type="button" id="ocr-cancel">${t("import.ocrCancel")}</button>
    </div>
  `;
  const textEl = () => overlay.querySelector<HTMLElement>("#ocr-progress-text");
  const etaEl = () => overlay.querySelector<HTMLElement>("#ocr-progress-eta");
  const fmt = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (textEl()) textEl().textContent = t(messageKey);
    if (etaEl()) etaEl().textContent = t(statusKey, { elapsed: fmt(elapsed) });
  };
  overlay.querySelector<HTMLButtonElement>("#ocr-cancel")?.addEventListener("click", (event) => {
    (event.currentTarget as HTMLButtonElement).disabled = true;
    if (textEl()) textEl().textContent = t("import.ocrCancelling");
    stopOcrProgress();
    onCancel();
  });
  tick();
  _ocrTimerHandle = setInterval(tick, 1000);
}

function stopOcrProgress() {
  if (_ocrTimerHandle) {
    clearInterval(_ocrTimerHandle);
    _ocrTimerHandle = null;
  }
}

export {
  readFileAsBase64,
  parseAndroidPdfRenderResponse,
  getAndroidPdfRendererBridge,
  renderAndSaveAndroidPdfPages,
  startAndroidPdfProgress,
  updateAndroidPdfProgress,
  stopAndroidPdfProgress,
  startOcrProgress,
  stopOcrProgress,
};
export type { AndroidPdfRenderResponse, PdfOcrPage, PdfImportResponse };
