/**
 * Reader rendering orchestrator: loading/empty state, header, text-select,
 * dispatch to plain-text or PDF-OCR renderers, tracking summary, text registry.
 * Tokenization happens once per plain-text render pass; the resulting page total
 * is cached so that page navigation does not re-tokenize.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, calcStatsPcts } from "../utils.js";
import { t } from "../i18n.js";
import { getTokenStats } from "../tokenizer_v2.js";
import { getAllBooks, bookTexts } from "../books.js";
import { renderPlainText } from "./text-renderer.js";
import { isPdfOcrText, renderPdfOcrReader } from "./pdf-ocr-renderer.js";
import {
  computeTotalPages,
  computePageSlice,
  cacheTotalPages,
  changeReaderPage,
  goToReaderPage
} from "./pagination.js";
import { getReaderSession } from "./session.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import type { TextStats } from "../tokenizer_v2.js";

interface ReaderLoadingBook {
  title: string;
  author?: string;
  source?: string;
}

export { changeReaderPage, goToReaderPage };

function getAllTexts(): WhText[] {
  const fromBooks = getAllBooks().map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    level: book.level,
    source: t("reader.sourceGutenberg"),
    sourceUrl: book.pageUrl,
    textUrl: book.textUrl,
    text: bookTexts.get(book.id) || book.sample || ""
  }));
  const fromCustom = (state.customTexts || []).map((ct) => ({
    ...ct,
    text: bookTexts.get(ct.id) || ct.text || ""
  }));
  return [...fromBooks, ...fromCustom];
}

export function getTextById(id: string | null): WhText | undefined {
  return getAllTexts().find((text) => text.id === id);
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

export function renderReader(): void {
  if (!els.readerText) return;
  const generation = ++readerRenderGeneration;
  delete els.readerText.dataset.renderId;
  els.readerText.classList.remove("pdf-ocr-reader", "pdf-text-layer-reader");
  if (loadingBook) {
    els.readerText.setAttribute("aria-busy", "true");
    els.readerText.dataset.rendering = "1";
    delete els.readerText.dataset.ttsText;
    if (els.textSelect) els.textSelect.innerHTML = `<option>${escapeHtml(loadingBook.title)}</option>`;
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
  const texts = getAllTexts();
  const current = texts.find((text) => text.id === state.currentTextId);

  if (!current) {
    els.readerText.removeAttribute("aria-busy");
    delete els.readerText.dataset.ttsText;
    if (els.textSelect) {
      els.textSelect.innerHTML = texts.map((text) => `<option value="${escapeHtml(text.id)}">${escapeHtml(text.title)}</option>`).join("");
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

  els.textSelect.innerHTML = texts.map((text) => {
    const selected = text.id === current.id ? "selected" : "";
    return `<option value="${escapeHtml(text.id)}" ${selected}>${escapeHtml(text.title)}</option>`;
  }).join("");

  els.readerHeading.textContent = current.title;
  els.readerSource.textContent = current.author || current.source || t("reader.localSource");
  els.readerText.style.fontSize = "";
  els.readerText.classList.toggle("pdf-ocr-reader", isPdfOcrText(current));
  els.readerText.classList.remove("pdf-text-layer-reader");
  delete els.readerText.dataset.ttsText;

  els.readerText.dataset.rendering = "1";
  els.readerText.setAttribute("aria-busy", "true");
  const scrollPerPageKey = state.currentTextId ? `${state.currentTextId}-p${state.readerPage}` : null;
  const savedPos = state.readerScrolls?.[current.id] || 0;

  if (isPdfOcrText(current)) {
    renderPdfOcrReader(current, scrollPerPageKey, savedPos);
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
       const stats = getTokenStats(tokens, state.vocab, language);
       renderTrackingSummary(stats);
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });

      const wordsPerPage = Number(state.preferences.wordsPerPage) || 1000;
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

      const { pageStartIndex, pageEndIndex } = computePageSlice(tokens, state.readerPage, wordsPerPage);
      renderPlainText({
        current,
        tokens,
        globalWordIndexes: session.globalWordIndexes,
        pageStartIndex,
        pageEndIndex,
        totalPages,
        scrollPerPageKey,
        savedPos
      });
    });  // inner setTimeout for spinner paint
  }, 10);
}
