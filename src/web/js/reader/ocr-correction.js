import { updatePdfOcrPageText } from "../book-actions/custom-text.js";
import { t } from "../i18n.js";
import { escapeAttribute, escapeHtml } from "../utils.js";
import { effectivePdfPageText, findPdfSentenceRange, replacePdfTextRange } from "./pdf-page-text.js";

let activeCorrectionDialog = null;
let correctionDialogCounter = 0;

export function openPdfOcrCorrection(current, pageIndex, options = {}) {
  const page = current?.pdfOcrPages?.[pageIndex];
  if (!page) return Promise.resolve(false);
  if (activeCorrectionDialog?.isConnected) {
    activeCorrectionDialog.querySelector("textarea")?.focus();
    return Promise.resolve(false);
  }
  const sourcePageText = effectivePdfPageText(page);
  const sentenceMode = Number.isInteger(options.wordIndex);
  const sentenceRange = sentenceMode
    ? findPdfSentenceRange(
      sourcePageText,
      options.wordIndex,
      current.lang || "en",
      options.algorithm || "modern"
    )
    : null;
  if (sentenceMode && !sentenceRange) return Promise.resolve(false);
  const expectedUpdatedAt = current.updatedAt || null;

  const dialog = document.createElement("dialog");
  const titleId = `pdf-correction-title-${++correctionDialogCounter}`;
  dialog.className = `panel pdf-correction-dialog${sentenceMode ? " pdf-correction-sentence" : ""}`;
  dialog.setAttribute("aria-labelledby", titleId);
  const imageName = String(page.imageName || "");
  const imageUrl = imageName
    ? `/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(imageName)}`
    : "";
  dialog.innerHTML = `
    <form class="pdf-correction-form">
      <div class="panel-header stacked">
        <p class="eyebrow">${escapeHtml(t("reader.pdfCorrectionEyebrow", { n: pageIndex + 1 }))}</p>
        <h2 id="${titleId}">${escapeHtml(t("reader.pdfCorrectionTitle"))}</h2>
        <p class="muted-copy">${escapeHtml(t("reader.pdfCorrectionHint"))}</p>
      </div>
      <div class="pdf-correction-grid">
        ${imageUrl ? `<figure class="pdf-correction-preview"><img src="${escapeAttribute(imageUrl)}" alt="${escapeAttribute(t("reader.pdfOcrPageAlt", { n: pageIndex + 1 }))}"></figure>` : ""}
        <label class="pdf-correction-field">
          <span>${escapeHtml(t(sentenceMode ? "reader.pdfCorrectionSentenceLabel" : "reader.pdfCorrectionLabel"))}</span>
          <textarea rows="${sentenceMode ? 7 : 18}"></textarea>
        </label>
      </div>
      <p class="muted-copy pdf-correction-status" role="status" aria-live="polite"></p>
      <div class="confirmation-dialog-actions">
        <button class="secondary-button" type="button" data-action="cancel">${escapeHtml(t("editBook.cancel"))}</button>
        <button class="primary-button" type="submit">${escapeHtml(t("editBook.save"))}</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  activeCorrectionDialog = dialog;

  const form = dialog.querySelector("form");
  const textarea = dialog.querySelector("textarea");
  const cancel = dialog.querySelector('[data-action="cancel"]');
  const submit = dialog.querySelector('[type="submit"]');
  const status = dialog.querySelector("[role=status]");
  textarea.value = sentenceMode
    ? sourcePageText.slice(sentenceRange.start, sentenceRange.end)
    : sourcePageText;

  return new Promise((resolve) => {
    let settled = false;
    let saving = false;
    const finish = (saved) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (activeCorrectionDialog === dialog) activeCorrectionDialog = null;
      resolve(saved);
    };
    cancel.addEventListener("click", () => finish(false));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (saving) return;
      finish(false);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      saving = true;
      form.setAttribute("aria-busy", "true");
      textarea.readOnly = true;
      submit.disabled = true;
      cancel.disabled = true;
      status.textContent = t("reader.pdfCorrectionSaving");
      try {
        const nextPageText = sentenceMode
          ? replacePdfTextRange(sourcePageText, sentenceRange, textarea.value)
          : textarea.value;
        if (nextPageText == null) throw new Error(t("reader.pdfCorrectionFailed"));
        const saved = await updatePdfOcrPageText(current.id, pageIndex, nextPageText, {
          expectedUpdatedAt
        });
        if (!saved) throw new Error(t("reader.pdfCorrectionFailed"));
        finish(true);
      } catch (error) {
        saving = false;
        console.warn("PDF OCR correction failed", error);
        form.removeAttribute("aria-busy");
        textarea.readOnly = false;
        submit.disabled = false;
        cancel.disabled = false;
        status.setAttribute("role", "alert");
        status.textContent = error?.message || t("toast.syncUnavailable");
        textarea.focus();
      }
    });
    dialog.showModal();
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
  });
}
