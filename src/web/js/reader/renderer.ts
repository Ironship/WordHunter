/**
 * Reader rendering orchestrator: loading/empty state, header, text-select,
 * dispatch to plain-text or PDF-OCR renderers, tracking summary, text registry.
 * Tokenization happens once per plain-text render pass; the resulting page total
 * is cached so that page navigation does not re-tokenize.
 */
import { getVocabularyRevision, state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, calcStatsPcts } from "../utils.js";
import { t } from "../i18n.js";
import { findBookById, getAllBooks, bookTexts } from "../books.js";
import { renderPlainText } from "./text-renderer.js";
import { isPdfOcrText, renderPdfOcrReader } from "./pdf-ocr-renderer.js";
import {
  computeTotalPages,
  computeIndexedPageSlice,
  cacheTotalPages,
  changeReaderPage,
  effectiveWordsPerPage,
  goToReaderPage
} from "./pagination.js";
import { analyzeReaderSession, getReaderSession } from "./session.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { renderReaderBookmarks } from "./bookmarks.js";
import type { TextStats } from "../tokenizer_v2.js";

interface ReaderLoadingBook {
  title: string;
  author?: string;
  source?: string;
}

export { changeReaderPage, goToReaderPage };

function readerTextOptions(): Array<{ id: string; title: string }> {
  return [
    ...getAllBooks().map(({ id, title }) => ({ id, title })),
    ...(state.customTexts || []).map(({ id, title }) => ({ id, title }))
  ];
}

function readerBodyReady(current: WhText): boolean {
  if (isPdfOcrText(current) || bookTexts.has(current.id)) return true;
  const customText = (state.customTexts || []).find((text) => text.id === current.id);
  return Boolean(customText && typeof customText.text === "string" && customText.text.trim());
}

export function getTextById(id: string | null): WhText | undefined {
  if (!id) return undefined;
  const custom = (state.customTexts || []).find((text) => text.id === id);
  if (custom) return { ...custom, text: bookTexts.peek(id) || custom.text || "" };
  const book = findBookById(id);
  if (!book) return undefined;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    level: book.level,
    source: t("reader.sourceGutenberg"),
    sourceUrl: book.pageUrl,
    textUrl: book.textUrl,
    text: bookTexts.peek(book.id) || book.sample || ""
  };
}

export function renderTrackingSummary(stats: TextStats): void {
  const { knownPct, learningPct, newPct } = calcStatsPcts(stats);
  const items = [
    {
      className: "tracking-known",
      label: t("reader.statsKnownIgnored"),
      title: t("reader.statsKnownIgnoredTitle"),
      value: knownPct
    },
    { className: "tracking-learning", label: t("reader.statsLearning"), title: t("reader.statsLearning"), value: learningPct },
    { className: "tracking-new", label: t("reader.statsNew"), title: t("reader.statsNew"), value: newPct }
  ];
  els.trackingSummary.innerHTML = items.map(({ className, label, title, value }) => {
    const percent = `${Math.round(value)}%`;
    const description = `${title}: ${percent}`;
    return `
      <span class="tracking-stat ${className}" title="${escapeAttribute(description)}" aria-label="${escapeAttribute(description)}">
        <strong>${percent}</strong>
        <span class="tracking-label">${escapeHtml(label)}</span>
      </span>
    `;
  }).join("");
  els.progressBar.style.width = `${knownPct}%`;
  if (els.progressBarLearning) els.progressBarLearning.style.width = `${learningPct}%`;
}

let loadingBook: ReaderLoadingBook | null = null;
let readerRenderGeneration = 0;
let textSelectElement: HTMLSelectElement | null = null;
let textSelectKey = "";
const WORD_PANEL_STATUS_CLASSES = ["word-panel-status-new", "word-panel-status-learning", "word-panel-status-known", "word-panel-status-ignored"];

function clearWordPanelStatus(): void {
  if (!els.wordPanel) return;
  els.wordPanel.classList?.remove(...WORD_PANEL_STATUS_CLASSES);
  els.wordPanel.parentElement?.classList.remove(...WORD_PANEL_STATUS_CLASSES);
  if (els.wordPanel.dataset) delete els.wordPanel.dataset.wordStatus;
}

export function setReaderLoading(book: ReaderLoadingBook): void {
  loadingBook = book;
  renderReader();
}

export function clearReaderLoading(): void {
  loadingBook = null;
}

function syncTextSelect(options: Array<{ id: string; title: string }>, selectedId: string | null): void {
  if (!els.textSelect) return;
  const key = options.map(({ id, title }) => `${id}\0${title}`).join("\x01");
  if (textSelectElement !== els.textSelect || textSelectKey !== key) {
    textSelectElement = els.textSelect;
    textSelectKey = key;
    els.textSelect.innerHTML = options
      .map(({ id, title }) => `<option value="${escapeHtml(id)}">${escapeHtml(title)}</option>`)
      .join("");
  }
  els.textSelect.value = selectedId || "";
}

export function renderReader(): void {
  if (!els.readerText) return;
  const generation = ++readerRenderGeneration;
  els.readerText.dataset.renderId = String(generation);
  els.readerText.classList.remove("pdf-ocr-reader", "pdf-text-layer-reader");
  if (loadingBook) {
    renderReaderBookmarks(null);
    els.readerText.setAttribute("aria-busy", "true");
    els.readerText.dataset.rendering = "1";
    delete els.readerText.dataset.ttsText;
    if (els.textSelect) {
      textSelectKey = "";
      els.textSelect.innerHTML = `<option>${escapeHtml(loadingBook.title)}</option>`;
    }
    if (els.readerHeading) els.readerHeading.textContent = loadingBook.title;
    if (els.readerSource) els.readerSource.textContent = loadingBook.author || loadingBook.source || t("reader.sourceGutenberg");
    if (els.trackingSummary) els.trackingSummary.textContent = "—";
    if (els.uniqueSummary) els.uniqueSummary.textContent = "";
    if (els.progressBar) els.progressBar.style.width = "0%";
    if (els.progressBarLearning) els.progressBarLearning.style.width = "0%";
    els.readerText.innerHTML = `
      <div class="reader-loading" role="status" aria-live="polite" aria-atomic="true">
        <div class="spinner" aria-hidden="true"></div>
        <p class="eyebrow">${escapeHtml(t("reader.loadingEyebrow"))}</p>
        <h3>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h3>
        <p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p>
        <div class="loading-bar"><div class="loading-bar-fill"></div></div>
      </div>`;
    if (els.wordPanel) {
      clearWordPanelStatus();
      els.wordPanel.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p><h2>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h2><p>${escapeHtml(t("reader.loadingHint"))}</p></div>`;
    }
    els.readerText.dataset.rendering = "0";
    return;
  }
  const textOptions = readerTextOptions();
  const current = getTextById(state.currentTextId);

  if (!current) {
    renderReaderBookmarks(null);
    els.readerText.removeAttribute("aria-busy");
    delete els.readerText.dataset.ttsText;
    if (els.textSelect) {
      syncTextSelect(textOptions, null);
    }
    if (els.readerHeading) els.readerHeading.textContent = t("reader.title");
    if (els.readerSource) els.readerSource.textContent = t("reader.source");
    if (els.trackingSummary) els.trackingSummary.textContent = "—";
    if (els.uniqueSummary) els.uniqueSummary.textContent = "";
    if (els.progressBar) els.progressBar.style.width = "0%";
    if (els.progressBarLearning) els.progressBarLearning.style.width = "0%";
    els.readerText.innerHTML = `<p>${escapeHtml(t("reader.empty"))}</p>`;
    if (els.wordPanel) {
      clearWordPanelStatus();
      els.wordPanel.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p><h2>${escapeHtml(t("reader.wordPanelHeading"))}</h2><p>${escapeHtml(t("reader.wordPanelHint"))}</p></div>`;
    }
    els.readerText.dataset.rendering = "0";
    return;
  }

  syncTextSelect(textOptions, current.id);

  els.readerHeading.textContent = current.title;
  els.readerSource.textContent = current.author || current.source || t("reader.localSource");
  renderReaderBookmarks(current.id);
  els.readerText.style.fontSize = "";
  els.readerText.classList.toggle("pdf-ocr-reader", isPdfOcrText(current));
  els.readerText.classList.remove("pdf-text-layer-reader");
  delete els.readerText.dataset.ttsText;

  if (!readerBodyReady(current)) {
    els.readerText.setAttribute("aria-busy", "true");
    els.readerText.dataset.rendering = "0";
    els.readerText.innerHTML = `<div class="reader-loading" role="status" aria-live="polite" aria-atomic="true"><div class="spinner" aria-hidden="true"></div><p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p></div>`;
    return;
  }

  els.readerText.dataset.rendering = "1";
  els.readerText.setAttribute("aria-busy", "true");
  const savedPos = state.readerScrolls?.[current.id] || 0;

  if (isPdfOcrText(current)) {
    renderPdfOcrReader(current, savedPos);
    return;
  }

  els.readerText.innerHTML = `<div class="reader-loading" role="status" aria-live="polite" aria-atomic="true" style="padding: 2rem; text-align: center;"><div class="spinner" aria-hidden="true" style="margin: 0 auto 1rem;"></div><p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p></div>`;

  setTimeout(() => {
    if (generation !== readerRenderGeneration || state.currentTextId !== current.id) return;
    // Defer again so the spinner paint is committed before heavy work
    setTimeout(() => {
      if (generation !== readerRenderGeneration || state.currentTextId !== current.id) return;
      // 1. Tokenize once, then derive both statistics and pagination from the result.
      const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
      const language = effectiveLearningLanguage(state.preferences);
      const session = getReaderSession(current, language, wordAlgorithm);
      const { tokens } = session;
      analyzeReaderSession(session, state.vocab, language, getVocabularyRevision());
      const stats = session.stats;
      renderTrackingSummary(stats);
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });

      const wordsPerPage = effectiveWordsPerPage(Number(state.preferences.wordsPerPage) || 1000);
      const totalPages = computeTotalPages(session.totalWords, wordsPerPage);
      cacheTotalPages(current.id, totalPages);

      // Restore saved position for this book
      if (state.readerPages && state.readerPages[current.id]) {
        state.readerPage = state.readerPages[current.id];
      }

      if (state.readerPage > totalPages) state.readerPage = totalPages;
      if (state.readerPage < 1) state.readerPage = 1;

      // Save position in case it was adjusted
      if (!state.readerPages) state.readerPages = {};
      state.readerPages[current.id] = state.readerPage;
      saveUiState();
      const scrollPerPageKey = `${current.id}-p${state.readerPage}`;

      const { pageStartIndex, pageEndIndex } = computeIndexedPageSlice(
        tokens.length,
        session.wordTokenIndexes,
        state.readerPage,
        wordsPerPage
      );
      renderPlainText({
        current,
        tokens,
        globalWordIndexes: session.globalWordIndexes,
        globalCharOffsets: session.globalCharOffsets,
        classifications: session.classifications,
        pageStartIndex,
        pageEndIndex,
        totalPages,
        scrollPerPageKey,
        savedPos
      });
    });  // inner setTimeout for spinner paint
  }, 10);
}
