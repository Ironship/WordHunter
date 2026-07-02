import { state } from "../state.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.js";
import { isAndroidPlatform } from "../platform.js";
import { parseImportedTextFile, titleFromImportedFileName } from "../subtitles.js";
import {
  cancelEditBook,
  importCustomText,
  isEditBookDirty,
  pasteImageToEditBook,
  saveEditedBook
} from "../book-actions.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";

let pendingCoverDataUrl = "";
let pendingImportMeta = {};
let youtubeTracks = [];
let youtubeTracksUrl = "";

function resetCoverPreview() {
  pendingCoverDataUrl = "";
  if (els.importCoverImg) els.importCoverImg.src = "";
  if (els.importCoverPreview) els.importCoverPreview.hidden = true;
  if (els.importCover) els.importCover.value = "";
  const dropzone = document.getElementById("import-cover-dropzone");
  if (dropzone) dropzone.style.display = "flex";
}

function setImportCoverPreview(dataUrl) {
  pendingCoverDataUrl = dataUrl || "";
  if (els.importCoverImg) els.importCoverImg.src = pendingCoverDataUrl;
  if (els.importCoverPreview) els.importCoverPreview.hidden = !pendingCoverDataUrl;
  const dropzone = document.getElementById("import-cover-dropzone");
  if (dropzone) dropzone.style.display = pendingCoverDataUrl ? "none" : "flex";
}

function clearPendingImportMeta() {
  pendingImportMeta = {};
}

function isEbookFile(file) {
  return /\.(epub|mobi|azw|azw3)$/i.test(file?.name || "");
}

function isPdfFile(file) {
  return file?.type === "application/pdf" || /\.pdf$/i.test(file?.name || "");
}

function slugFromFileName(name) {
  const base = titleFromImportedFileName(name || t("import.importedPdfTitle"));
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || Date.now();
}

async function readFileAsBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseAndroidPdfRenderResponse(raw, fallbackMessage) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw || ""));
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!payload?.success) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
}

function getAndroidPdfRendererBridge() {
  const bridge = window.WordHunterAndroid;
  if (!bridge || typeof bridge.beginPdfRender !== "function" || typeof bridge.renderPdfPage !== "function") {
    return null;
  }
  return bridge;
}

async function renderAndSaveAndroidPdfPages(data, bookId, pages) {
  if (!isAndroidPlatform() || !pages.length) return;
  const bridge = getAndroidPdfRendererBridge();
  if (!bridge) throw new Error(t("toast.pdfOcrRequiresApp"));

  const sessionId = `wh-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  parseAndroidPdfRenderResponse(
    bridge.beginPdfRender(sessionId, data),
    t("toast.pdfOcrNoText")
  );
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const rendered = parseAndroidPdfRenderResponse(
        bridge.renderPdfPage(sessionId, index, 1400),
        t("toast.pdfOcrNoText")
      );
      if (!rendered.dataUrl || !page?.imageName) {
        throw new Error(t("toast.pdfOcrNoText"));
      }
      const response = await fetch("/__book/image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({
          book_id: bookId,
          img_name: page.imageName,
          base64_data: rendered.dataUrl
        })
      });
      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `HTTP ${response.status}`);
      }
    }
  } finally {
    if (typeof bridge.endPdfRender === "function") bridge.endPdfRender(sessionId);
  }
}

function setImportLoading(visible, messageKey = "import.parsingEbook") {
  let overlay = document.getElementById("import-loading");
  if (visible) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "import-loading";
      overlay.className = "section-loading";
      overlay.style.position = "absolute";
      overlay.style.zIndex = "10";
      overlay.style.background = "var(--panel)";
      const form = document.getElementById("import-form");
      if (form) form.style.position = "relative", form.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="muted-copy">${t(messageKey)}</p>`;
    overlay.hidden = false;
  } else {
    const ov = document.getElementById("import-loading");
    if (ov) ov.hidden = true;
  }
}

let _ocrTimerHandle = null;
function startOcrProgress(onCancel) {
  stopOcrProgress();
  const overlay = document.getElementById("import-loading");
  if (!overlay) return;
  const startedAt = Date.now();
  overlay.innerHTML = `
    <div class="spinner" aria-hidden="true"></div>
    <p class="muted-copy" id="ocr-progress-text"></p>
    <div class="ocr-progress-bar"><div class="ocr-progress-bar-fill"></div></div>
    <p class="muted-copy ocr-progress-eta" id="ocr-progress-eta"></p>
    <button class="secondary-button" type="button" id="ocr-cancel">${t("import.ocrCancel")}</button>
  `;
  const textEl = () => overlay.querySelector("#ocr-progress-text");
  const etaEl = () => overlay.querySelector("#ocr-progress-eta");
  const fmt = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (textEl()) textEl().textContent = t("import.parsingPdfOcr");
    if (etaEl()) etaEl().textContent = t("import.ocrWholeBookStatus", { elapsed: fmt(elapsed) });
  };
  overlay.querySelector("#ocr-cancel")?.addEventListener("click", () => {
    overlay.querySelector("#ocr-cancel").disabled = true;
    if (etaEl()) etaEl().textContent = t("import.ocrCancelling");
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

function setYoutubeImportLoading(loading, statusKey = "import.youtubeLoading") {
  if (els.importYoutubeLoad) {
    els.importYoutubeLoad.disabled = loading;
    els.importYoutubeLoad.textContent = t(loading ? statusKey : (youtubeTracks.length ? "import.youtubeImportSelected" : "import.youtubeLoad"));
  }
  if (loading && els.importYoutubeStatus) els.importYoutubeStatus.textContent = t(statusKey);
}

function resetYoutubeTracks(clearUrl = false) {
  youtubeTracks = [];
  youtubeTracksUrl = "";
  if (clearUrl && els.importYoutubeUrl) els.importYoutubeUrl.value = "";
  if (els.importYoutubeTrack) {
    els.importYoutubeTrack.innerHTML = "";
    els.importYoutubeTrack.hidden = true;
  }
  if (els.importYoutubeLoad) els.importYoutubeLoad.textContent = t("import.youtubeLoad");
  if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = "";
}

async function youtubeCaptionsRequest(payload) {
  const response = await fetch("/__youtube/captions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

function youtubeTrackLabel(track) {
  const label = track.label || track.languageCode || t("import.youtubeUnknownLanguage");
  const suffix = track.isAutoGenerated ? t("import.youtubeAutoTrack") : t("import.youtubeManualTrack");
  return `${label} · ${suffix}`;
}

async function loadYoutubeTracks(url) {
  setYoutubeImportLoading(true, "import.youtubeLoading");
  const data = await youtubeCaptionsRequest({ op: "tracks", url });
  youtubeTracks = Array.isArray(data.tracks) ? data.tracks : [];
  youtubeTracksUrl = url;
  if (!youtubeTracks.length) {
    resetYoutubeTracks(false);
    if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = t("import.youtubeNoTracks");
    return null;
  }
  if (els.importYoutubeTrack) {
    els.importYoutubeTrack.replaceChildren(
      ...youtubeTracks.map((track) => new Option(youtubeTrackLabel(track), String(track.index)))
    );
    els.importYoutubeTrack.hidden = youtubeTracks.length < 2;
  }
  if (els.importYoutubeLoad) els.importYoutubeLoad.textContent = t("import.youtubeImportSelected");
  if (youtubeTracks.length > 1) {
    if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = t("import.youtubeChooseTrack", { count: youtubeTracks.length });
    return null;
  }
  return youtubeTracks[0];
}

async function importYoutubeTrack(url, trackIndex) {
  setYoutubeImportLoading(true, "import.youtubeImporting");
  const data = await youtubeCaptionsRequest({ op: "download", url, track_index: Number(trackIndex) });
  if (!data.text) throw new Error(t("import.youtubeNoText"));
  els.importText.value = data.text;
  if (!els.importTitle.value.trim()) els.importTitle.value = data.title || t("import.youtubeImportedTitle");
  if (els.importAuthor && !els.importAuthor.value.trim()) els.importAuthor.value = data.author || "";
  setImportCoverPreview(data.thumbnailUrl || "");
  pendingImportMeta = {
    source: t("import.youtubeSource"),
    sourceUrl: data.sourceUrl || url,
    textUrl: data.sourceUrl || url
  };
  if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = t("import.youtubeLoaded");
  showToast(t("toast.youtubeCaptionsLoaded"));
}

async function handleYoutubeImport() {
  const url = els.importYoutubeUrl?.value.trim();
  if (!url) {
    if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = t("import.youtubeMissingUrl");
    return;
  }
  try {
    if (!youtubeTracks.length || youtubeTracksUrl !== url) {
      const onlyTrack = await loadYoutubeTracks(url);
      if (!onlyTrack) return;
      await importYoutubeTrack(url, onlyTrack.index);
      return;
    }
    const selectedIndex = els.importYoutubeTrack?.value || youtubeTracks[0]?.index;
    await importYoutubeTrack(url, selectedIndex);
  } catch (error) {
    console.warn(error);
    resetYoutubeTracks(false);
    const message = error?.message?.trim() || t("import.youtubeError");
    if (els.importYoutubeStatus) els.importYoutubeStatus.textContent = message;
    showToast(t("toast.youtubeCaptionsError"));
  } finally {
    setYoutubeImportLoading(false);
  }
}

function confirmWholeBookOcr() {
  const dialog = document.getElementById("ocr-whole-book-confirm") || (() => {
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
  dialog.querySelector("h2").textContent = t("import.ocrWholeBookTitle");
  dialog.querySelector("p").textContent = t("import.ocrWholeBookConfirm");
  dialog.querySelector('[data-action="cancel"]').textContent = t("import.ocrWholeBookCancel");
  dialog.querySelector('[data-action="confirm"]').textContent = t("import.ocrWholeBookStart");

  return new Promise((resolve) => {
    const finish = (accepted) => {
      dialog.close();
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", backdrop);
      cancelButton.removeEventListener("click", cancel);
      confirmButton.removeEventListener("click", confirm);
      resolve(accepted);
    };
    const cancel = (event) => { event?.preventDefault(); finish(false); };
    const confirm = () => finish(true);
    const backdrop = (event) => { if (event.target === dialog) cancel(); };
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const confirmButton = dialog.querySelector('[data-action="confirm"]');
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", backdrop);
    cancelButton.addEventListener("click", cancel);
    confirmButton.addEventListener("click", confirm);
    dialog.showModal();
  });
}

async function importPdfFile(file) {
  const androidPdfOverlay = isAndroidPlatform();
  if (!window.__qtBridge && !androidPdfOverlay) {
    throw new Error(t("toast.pdfOcrRequiresApp"));
  }
  if (!androidPdfOverlay && !await confirmWholeBookOcr()) return false;
  const lang = state.preferences.learningLanguage || "en";
  const id = `${lang}-pdf-ocr-${slugFromFileName(file.name)}-${Date.now()}`;
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  let cancelled = false;
  let requestStarted = false;
  setImportLoading(true, "import.parsingPdfOcr");
  if (!androidPdfOverlay) {
    startOcrProgress(() => {
      cancelled = true;
      controller.abort();
      if (requestStarted) {
        void fetch("/__import/pdf_ocr/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
          body: JSON.stringify({ job_id: jobId })
        });
      }
    });
  }
  try {
    const data = await readFileAsBase64(file);
    if (cancelled) return false;
    requestStarted = true;
    const response = await fetch("/__import/pdf_ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      signal: controller.signal,
      body: JSON.stringify({
        book_id: id,
        job_id: jobId,
        filename: file.name || t("import.importedPdfTitle"),
        data,
        lang,
        max_pages: 0
      })
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      if (message.trim() === "PDF_TEXT_LAYER_EMPTY") {
        throw new Error(t("toast.pdfPocketScanRequiresPc"));
      }
      throw new Error(message || `HTTP ${response.status}`);
    }
    const imported = await response.json();
    const pages = Array.isArray(imported.pages) ? imported.pages : [];
    const text = imported.text || pages.map((page) => page.text || "").join("\n\n").trim();
    if (!text) throw new Error(t("toast.pdfOcrNoText"));
    const pageCount = imported.pageCount || pages.length;
    const ocrEngine = imported.ocrEngine || "PaddleOCR";
    const hasOverlayPages = pages.length > 0;
    if (androidPdfOverlay && hasOverlayPages) {
      await renderAndSaveAndroidPdfPages(data, id, pages);
    }
    const blurb = hasOverlayPages
      ? imported.truncated
        ? t("import.pdfOcrBlurbTruncated", { processed: pages.length, total: pageCount, engine: ocrEngine })
        : t("import.pdfOcrBlurb", { pages: pages.length, engine: ocrEngine })
      : t("import.pdfTextLayerBlurb", { pages: pageCount });
    await importCustomText(imported.title || titleFromImportedFileName(file.name || t("import.importedPdfTitle")), text, {
      id,
      blurb,
      coverDataUrl: hasOverlayPages && pages[0]?.imageName ? `/__media?book=${encodeURIComponent(id)}&img=${encodeURIComponent(pages[0].imageName)}` : "",
      pdfOcrPages: hasOverlayPages ? pages : undefined,
      pdfOcrEngine: hasOverlayPages ? ocrEngine : "",
      pdfOcrPageCount: hasOverlayPages ? pageCount : 0,
      experimental: hasOverlayPages
    });
    return true;
  } catch (error) {
    if (cancelled) {
      showToast(t("import.ocrCancelled"));
      return false;
    }
    throw error;
  } finally {
    stopOcrProgress();
    setImportLoading(false);
  }
}

async function importEbookFile(file) {
  if (!window.__qtBridge) {
    throw new Error(t("toast.ebookRequiresApp"));
  }
  setImportLoading(true);
  try {
    const response = await fetch("/__import/ebook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ filename: file.name, data: await readFileAsBase64(file) })
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    setImportLoading(false);
  }
}

async function loadImportFile(file) {
  clearPendingImportMeta();
  resetYoutubeTracks(false);

  if (isPdfFile(file)) {
    return importPdfFile(file);
  }

  if (isEbookFile(file)) {
    const ebook = await importEbookFile(file);
    if (!ebook.text) throw new Error(t("toast.importedEbookEmpty"));
    els.importText.value = ebook.text;
    if (!els.importTitle.value.trim()) els.importTitle.value = ebook.title || titleFromImportedFileName(file.name);
    if (els.importAuthor && !els.importAuthor.value.trim()) els.importAuthor.value = ebook.author || "";
    setImportCoverPreview(ebook.coverDataUrl || "");
    return;
  }

  const rawText = await file.text();
  const text = parseImportedTextFile(file, rawText);
  if (!text) throw new Error(t("toast.importedFileEmpty"));
  els.importText.value = text;
  if (!els.importTitle.value.trim()) {
    els.importTitle.value = titleFromImportedFileName(file.name);
  }
}

function handleImportCoverFile(file) {
  if (!file) return;
  if (file.size > 1_500_000) {
    showToast(t("toast.coverTooBig"));
    if (els.importCover) els.importCover.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { setImportCoverPreview(String(reader.result || "")); };
  reader.readAsDataURL(file);
}

function handleEditCoverFile(file) {
  if (!file) return;
  if (file.size > 1_500_000) {
    showToast(t("toast.coverTooBig"));
    if (els.editBookCover) els.editBookCover.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    import("../book-actions.js").then(m => m.setPendingEditCoverDataUrl(dataUrl));
    if (els.editBookCoverImg) els.editBookCoverImg.src = dataUrl;
    if (els.editBookCoverPreview) els.editBookCoverPreview.hidden = false;
    const dropzone = document.getElementById("edit-book-cover-dropzone");
    if (dropzone) dropzone.style.display = "none";
  };
  reader.readAsDataURL(file);
}

function bindImportFormEvents() {
  if (els.importYoutubeLoad) {
    els.importYoutubeLoad.addEventListener("click", () => handleYoutubeImport());
  }

  if (els.importYoutubeUrl) {
    els.importYoutubeUrl.addEventListener("input", () => {
      clearPendingImportMeta();
      resetYoutubeTracks(false);
    });
    els.importYoutubeUrl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleYoutubeImport();
      }
    });
  }

  if (els.importFile) {
    els.importFile.addEventListener("change", async () => {
      const file = els.importFile.files?.[0];
      if (!file) return;
      try {
        if (await loadImportFile(file) !== false) showToast(t("toast.fileLoaded", { name: file.name }));
      } catch (err) {
        console.warn(err);
        showToast(err?.message?.trim() || t("toast.fileError"));
      }
    });
  }

  if (els.importCover) {
    els.importCover.addEventListener("change", () => handleImportCoverFile(els.importCover.files?.[0]));
  }

  if (els.importCoverClear) {
    els.importCoverClear.addEventListener("click", () => {
      pendingCoverDataUrl = null;
      if (els.importCoverImg) els.importCoverImg.src = "";
      if (els.importCoverPreview) els.importCoverPreview.hidden = true;
      if (els.importCover) els.importCover.value = "";
      const dropzone = document.getElementById("import-cover-dropzone");
      if (dropzone) dropzone.style.display = "flex";
    });
  }

  els.importForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const meta = {
      ...pendingImportMeta,
      author: els.importAuthor?.value || pendingImportMeta.author,
      tags: els.importTags?.value,
      coverDataUrl: pendingCoverDataUrl
    };
    const levelVal = els.importLevel?.value;
    if (levelVal) meta.level = levelVal;
    try {
      await importCustomText(els.importTitle.value, els.importText.value, meta);
      els.importForm.reset();
      clearPendingImportMeta();
      resetYoutubeTracks(true);
      resetCoverPreview();
    } catch (e) {
      console.error("import custom text failed", e);
    }
  });
}

function bindEditBookEvents() {
  registerUnsavedDialog("edit-book-dialog", isEditBookDirty, () => saveEditedBook());
  if (els.editBookCancel) els.editBookCancel.addEventListener("click", () => cancelEditBook());
  if (els.editBookSave) els.editBookSave.addEventListener("click", () => saveEditedBook());

  if (els.editBookDialog) {
    els.editBookDialog.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        saveEditedBook();
      }
    });
  }

  if (els.editBookCoverClear) {
    els.editBookCoverClear.addEventListener("click", () => {
      import("../book-actions.js").then(m => m.setPendingEditCoverDataUrl(null));
      if (els.editBookCoverImg) els.editBookCoverImg.src = "";
      if (els.editBookCoverPreview) els.editBookCoverPreview.hidden = true;
      if (els.editBookCover) els.editBookCover.value = "";
      const dropzone = document.getElementById("edit-book-cover-dropzone");
      if (dropzone) dropzone.style.display = "flex";
    });
  }

  if (els.editBookCover) {
    els.editBookCover.addEventListener("change", () => handleEditCoverFile(els.editBookCover.files?.[0]));
  }

  if (els.editBookText) {
    els.editBookText.addEventListener("paste", (e) => {
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
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

function isTextEditingPasteTarget(target) {
  return !!target?.closest?.("textarea, input, [contenteditable='true']");
}

function bindCoverPasteEvents() {
  document.addEventListener("paste", (e) => {
    if (isTextEditingPasteTarget(e.target)) return;
    const importOpen = state.currentView === "library";
    const editOpen = els.editBookDialog && els.editBookDialog.open;
    if (!importOpen && !editOpen) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
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
