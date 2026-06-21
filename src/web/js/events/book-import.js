import { state } from "../state.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.js";
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
  if (!window.__qtBridge) {
    throw new Error(t("toast.pdfOcrRequiresApp"));
  }
  if (!await confirmWholeBookOcr()) return false;
  const lang = state.preferences.learningLanguage || "en";
  const id = `${lang}-pdf-ocr-${slugFromFileName(file.name)}-${Date.now()}`;
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  let cancelled = false;
  let requestStarted = false;
  setImportLoading(true, "import.parsingPdfOcr");
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
      throw new Error(message || `HTTP ${response.status}`);
    }
    const imported = await response.json();
    const pages = Array.isArray(imported.pages) ? imported.pages : [];
    const text = imported.text || pages.map((page) => page.text || "").join("\n\n").trim();
    if (!text) throw new Error(t("toast.pdfOcrNoText"));
    const pageCount = imported.pageCount || pages.length;
    const ocrEngine = imported.ocrEngine || "PaddleOCR";
    const blurb = imported.truncated
      ? t("import.pdfOcrBlurbTruncated", { processed: pages.length, total: pageCount, engine: ocrEngine })
      : t("import.pdfOcrBlurb", { pages: pages.length, engine: ocrEngine });
    await importCustomText(imported.title || titleFromImportedFileName(file.name || t("import.importedPdfTitle")), text, {
      id,
      blurb,
      coverDataUrl: pages[0]?.imageName ? `/__media?book=${encodeURIComponent(id)}&img=${encodeURIComponent(pages[0].imageName)}` : "",
      pdfOcrPages: pages,
      pdfOcrEngine: ocrEngine,
      pdfOcrPageCount: pageCount,
      experimental: true
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
  if (els.importFile) {
    els.importFile.addEventListener("change", async () => {
      const file = els.importFile.files?.[0];
      if (!file) return;
      try {
        if (await loadImportFile(file) !== false) showToast(t("toast.fileLoaded", { name: file.name }));
      } catch (err) {
        console.warn(err);
        showToast(t("toast.fileError"));
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
      author: els.importAuthor?.value,
      tags: els.importTags?.value,
      coverDataUrl: pendingCoverDataUrl
    };
    const levelVal = els.importLevel?.value;
    if (levelVal) meta.level = levelVal;
    try {
      await importCustomText(els.importTitle.value, els.importText.value, meta);
      els.importForm.reset();
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
