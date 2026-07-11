/**
 * PDF-OCR reader rendering: page image + word overlay, layout estimation,
 * per-page text extraction, word-token emission.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, clamp } from "../utils.js";
import { t } from "../i18n.js";
import { findGermanSeparableVerbMatches, normalizeWord, getTokenStats, tokenizeText } from "../tokenizer_v2.js";
import { restoreReaderScrollPosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";
import { cacheTotalPages, paginationHtml } from "./pagination.js";
import { renderTrackingSummary } from "./renderer.js";
import { getLearningColor } from "../reader-colors.js";
import { icon } from "../icons.js";
import { countEffectivePdfPageWords, effectivePdfPageText, reconcilePdfPageWords } from "./pdf-page-text.js";
import { getReaderSession } from "./session.js";

const PDF_OCR_LAYOUT_FONT = `"Times New Roman", Georgia, serif`;
const PDF_TEXT_LAYER_BOUNDS_VERSION = "text-glyph-v2";
const PDF_OCR_ZOOM_MIN = 0.75;
const PDF_OCR_ZOOM_MAX = 3;
const PDF_OCR_ZOOM_STEP = 0.15;
let pdfOcrMeasureContext = null;

export function isPdfOcrText(text) {
  return Array.isArray(text?.pdfOcrPages) && text.pdfOcrPages.length > 0;
}

export function getPdfOcrZoom() {
  return normalizePdfOcrZoom(state.readerPdfZoom);
}

export function getPdfOcrViewMode() {
  return state.readerPdfViewMode === "text" ? "text" : "overlay";
}

export function setPdfOcrViewMode(value, options = {}) {
  const mode = value === "text" ? "text" : "overlay";
  if (state.readerPdfViewMode !== mode) state.readerPdfViewMode = mode;
  if (options.commit !== false) saveUiState();
  return mode;
}

export function setPdfOcrZoom(value, options = {}) {
  const zoom = normalizePdfOcrZoom(value);
  const container = els.readerText;
  const page = container?.querySelector?.(".pdf-ocr-page");
  const anchor = page ? getPdfOcrZoomAnchor(container, page, options) : null;
  if (state.readerPdfZoom !== zoom) state.readerPdfZoom = zoom;
  applyPdfOcrZoomToDom(zoom);
  if (anchor) restorePdfOcrZoomAnchor(container, page, anchor);
  if (options.commit !== false) saveUiState();
  return zoom;
}

export function adjustPdfOcrZoom(delta, options = {}) {
  return setPdfOcrZoom(getPdfOcrZoom() + delta, options);
}

export function resetPdfOcrZoom(options = {}) {
  return setPdfOcrZoom(1, options);
}

export function pdfOcrZoomStep() {
  return PDF_OCR_ZOOM_STEP;
}

export function renderPdfOcrReader(current, scrollPerPageKey, savedPos) {
  const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const session = getReaderSession(current, state.preferences.learningLanguage || "en", wordAlgorithm);
  const stats = getTokenStats(session.tokens, state.vocab, state.preferences.learningLanguage || "en");
  renderTrackingSummary(stats);
  els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });

  const pages = current.pdfOcrPages;
  const totalPages = Math.max(1, pages.length);
  cacheTotalPages(current.id, totalPages);
  if (state.readerPages && state.readerPages[current.id]) {
    state.readerPage = state.readerPages[current.id];
  }
  state.readerPage = clamp(Math.round(state.readerPage) || 1, 1, totalPages);
  if (!state.readerPages) state.readerPages = {};
  state.readerPages[current.id] = state.readerPage;
  saveUiState();

  const pageIndex = state.readerPage - 1;
  const page = pages[pageIndex] || pages[0] || {};
  els.readerText.dataset.ttsText = effectivePdfPageText(page);
  const globalOffset = pages.slice(0, pageIndex).reduce(
    (sum, item) => sum + countEffectivePdfPageWords(
      item,
      state.preferences.learningLanguage || "en",
      wordAlgorithm
    ),
    0
  );
  const viewMode = getPdfOcrViewMode();
  const overlayMode = viewMode === "overlay";
  els.readerText.classList.toggle("pdf-ocr-reader", overlayMode);
  els.readerText.classList.toggle("pdf-text-layer-reader", !overlayMode);

  if (!overlayMode) {
    renderPdfOcrTextMode(current, page, globalOffset, totalPages, scrollPerPageKey, savedPos);
    return;
  }

  const imageName = page.imageName || "";
  const imageUrl = `/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(imageName)}`;
  const sourcePageWords = getPdfOcrPageWords(page);
  const pageWords = Object.hasOwn(page, "correctedText")
    ? reconcilePdfPageWords(
      sourcePageWords,
      effectivePdfPageText(page),
      state.preferences.learningLanguage || "en",
      wordAlgorithm
    )
    : sourcePageWords;
  const overlayTokens = pageWords.flatMap((word) => {
    const raw = String(word?.text || "");
    return [
      { type: "word", value: raw },
      { type: "text", value: raw.match(/[.!?;,\n\r]+$/u)?.[0] || " " }
    ];
  });
  const separableVerbMatches = findGermanSeparableVerbMatches(
    overlayTokens,
    state.vocab,
    state.preferences.learningLanguage || "en"
  );
  const overlayWordIndexes = mapPdfOverlayWordIndexes(
    pageWords,
    effectivePdfPageText(page),
    state.preferences.learningLanguage || "en",
    wordAlgorithm,
    globalOffset
  );
  const wordsHtml = pageWords
    .map((word, index) => renderPdfOcrWord(
      word,
      page,
      overlayWordIndexes[index],
      current,
      separableVerbMatches.get(index * 2),
      index
    ))
    .join("");
  const zoom = getPdfOcrZoom();
  const { stageWidthPercent, pageWidthPercent } = pdfOcrZoomLayout(zoom);

  els.readerText.innerHTML = `
    ${renderPdfOcrToolbar(zoom, viewMode)}
    <div class="pdf-ocr-stage" style="width:${stageWidthPercent}%;">
      <div class="pdf-ocr-page" style="--pdf-page-width:${Number(page.width) || 1}; --pdf-page-height:${Number(page.height) || 1}; width:${pageWidthPercent}%;">
        <img class="pdf-ocr-page-image" src="${escapeAttribute(imageUrl)}" alt="${escapeAttribute(t("reader.pdfOcrPageAlt", { n: state.readerPage }))}">
        <div class="pdf-ocr-overlay" aria-label="${escapeAttribute(t("reader.pdfOcrOverlayLabel"))}">
          ${wordsHtml}
        </div>
      </div>
    </div>
    ${totalPages > 1 ? paginationHtml(current.id, state.readerPage, totalPages, t) : ""}
  `;

  renderWordPanel(current);
  const perPageScroll = state.readerScrollsPerPage?.[scrollPerPageKey];
  if (perPageScroll !== undefined) {
    els.readerText.scrollTop = perPageScroll;
    els.readerText.dataset.rendering = "0";
  } else {
    const savedScroll = state.readerScrolls?.[current.id];
    if (savedScroll && typeof savedScroll === "object" && savedScroll.readerPage != null && savedScroll.readerPage !== state.readerPage) {
      els.readerText.scrollTop = 0;
      els.readerText.dataset.rendering = "0";
    } else {
      restoreReaderScrollPosition(current.id, savedPos);
    }
  }
  updateReaderSelection();
  els.readerText.dataset.rendering = "0";
  els.readerText.removeAttribute("aria-busy");
}

function renderPdfOcrTextMode(current, page, globalOffset, totalPages, scrollPerPageKey, savedPos) {
  const pageText = effectivePdfPageText(page);
  const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const tokens = tokenizeText(pageText, state.preferences.learningLanguage || "en", wordAlgorithm);
  const textHtml = renderPdfOcrTextTokens(tokens, globalOffset);
  const emptyHtml = `<p class="muted-copy">${escapeHtml(t("reader.empty"))}</p>`;

  els.readerText.innerHTML = [
    renderPdfOcrToolbar(getPdfOcrZoom(), getPdfOcrViewMode()),
    `<div class="pdf-text-page" aria-label="${escapeAttribute(t("reader.pdfTextPageLabel", { n: state.readerPage }))}">${textHtml || emptyHtml}</div>`,
    totalPages > 1 ? paginationHtml(current.id, state.readerPage, totalPages, t) : ""
  ].join("");

  renderWordPanel(current);
  const perPageScroll = state.readerScrollsPerPage?.[scrollPerPageKey];
  if (perPageScroll !== undefined) {
    els.readerText.scrollTop = perPageScroll;
    els.readerText.dataset.rendering = "0";
  } else {
    const savedScroll = state.readerScrolls?.[current.id];
    if (savedScroll && typeof savedScroll === "object" && savedScroll.readerPage != null && savedScroll.readerPage !== state.readerPage) {
      els.readerText.scrollTop = 0;
      els.readerText.dataset.rendering = "0";
    } else {
      restoreReaderScrollPosition(current.id, savedPos);
    }
  }
  updateReaderSelection();
  els.readerText.dataset.rendering = "0";
  els.readerText.removeAttribute("aria-busy");
}

function renderPdfOcrTextTokens(tokens, globalOffset) {
  let html = "";
  let wordCount = 0;
  const separableVerbMatches = findGermanSeparableVerbMatches(
    tokens,
    state.vocab,
    state.preferences.learningLanguage || "en"
  );
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type !== "word") {
      html += escapeHtml(token.value || "");
      continue;
    }

    const raw = String(token.value || "");
    const word = normalizeWord(raw);
    const dataWord = separableVerbMatches.get(tokenIndex) || word;
    const entry = state.vocab[dataWord];
    const status = entry ? entry.status : "new";
    const selected = state.selectedWord === dataWord ? "selected" : "";
    const color = status === "learning" ? getLearningColor(entry, state.preferences) : "";
    const style = color ? ` style="--token-learning-bg:${color}"` : "";
    html += `<button class="word-token status-${status} ${selected}" type="button" data-word="${escapeAttribute(dataWord)}" data-word-index="${globalOffset + wordCount}"${style}>${escapeHtml(raw)}</button>`;
    wordCount += 1;
  }
  return html;
}

function normalizePdfOcrZoom(value) {
  const zoom = Number(value);
  return clamp(Number.isFinite(zoom) ? zoom : 1, PDF_OCR_ZOOM_MIN, PDF_OCR_ZOOM_MAX);
}

function pdfOcrZoomLayout(zoom) {
  const normalized = normalizePdfOcrZoom(zoom);
  const stageScale = Math.max(1, normalized);
  const pageScale = normalized / stageScale;
  return {
    stageWidthPercent: (stageScale * 100).toFixed(2),
    pageWidthPercent: (pageScale * 100).toFixed(2)
  };
}

function renderPdfOcrToolbar(zoom, viewMode) {
  const textMode = viewMode === "text";
  const targetMode = textMode ? "overlay" : "text";
  const targetLabel = textMode ? t("reader.pdfShowBackground") : t("reader.pdfShowText");
  const modeButton = `
    <button type="button" class="icon-button pdf-ocr-mode-button" data-pdf-view-mode="${escapeAttribute(targetMode)}" title="${escapeAttribute(targetLabel)}" aria-label="${escapeAttribute(targetLabel)}">
      ${icon(textMode ? "fileImage" : "fileText", 16)}
    </button>
  `;
  const correctButton = `
    <button type="button" class="icon-button pdf-ocr-correct-button" data-pdf-correct title="${escapeAttribute(t("reader.pdfCorrectText"))}" aria-label="${escapeAttribute(t("reader.pdfCorrectText"))}">
      ${icon("edit", 16)}
    </button>
  `;
  if (textMode) {
    return `<div class="pdf-ocr-toolbar" aria-label="${escapeAttribute(t("reader.pdfViewModeLabel"))}">${correctButton}${modeButton}</div>`;
  }

  const percent = `${Math.round(zoom * 100)}%`;
  const outDisabled = zoom <= PDF_OCR_ZOOM_MIN + 0.001 ? " disabled" : "";
  const inDisabled = zoom >= PDF_OCR_ZOOM_MAX - 0.001 ? " disabled" : "";
  return `
    <div class="pdf-ocr-toolbar" aria-label="${escapeAttribute(t("reader.pdfZoomLabel"))}">
      ${correctButton}
      <button type="button" class="icon-button pdf-ocr-sentence-button" data-pdf-correct-sentence title="${escapeAttribute(t("reader.pdfCorrectSentence"))}" aria-label="${escapeAttribute(t("reader.pdfCorrectSentence"))}" disabled>
        ${icon("sentenceEdit", 16)}
      </button>
      ${modeButton}
      <button type="button" class="icon-button pdf-ocr-zoom-button" data-pdf-zoom="out" title="${escapeAttribute(t("reader.pdfZoomOut"))}" aria-label="${escapeAttribute(t("reader.pdfZoomOut"))}"${outDisabled}>${icon("minus", 16)}</button>
      <button type="button" class="secondary-button pdf-ocr-zoom-reset" data-pdf-zoom="reset" title="${escapeAttribute(t("reader.pdfZoomReset"))}" aria-label="${escapeAttribute(t("reader.pdfZoomReset"))}"><span data-pdf-zoom-value>${escapeHtml(percent)}</span></button>
      <button type="button" class="icon-button pdf-ocr-zoom-button" data-pdf-zoom="in" title="${escapeAttribute(t("reader.pdfZoomIn"))}" aria-label="${escapeAttribute(t("reader.pdfZoomIn"))}"${inDisabled}>${icon("plus", 16)}</button>
    </div>
  `;
}

function applyPdfOcrZoomToDom(zoom) {
  const container = els.readerText;
  const stage = container?.querySelector?.(".pdf-ocr-stage");
  const page = container?.querySelector?.(".pdf-ocr-page");
  const layout = pdfOcrZoomLayout(zoom);
  if (stage) stage.style.width = `${layout.stageWidthPercent}%`;
  if (page) page.style.width = `${layout.pageWidthPercent}%`;
  const value = container?.querySelector?.("[data-pdf-zoom-value]");
  if (value) value.textContent = `${Math.round(zoom * 100)}%`;
  const zoomOut = container?.querySelector?.("[data-pdf-zoom='out']");
  if (zoomOut) zoomOut.disabled = zoom <= PDF_OCR_ZOOM_MIN + 0.001;
  const zoomIn = container?.querySelector?.("[data-pdf-zoom='in']");
  if (zoomIn) zoomIn.disabled = zoom >= PDF_OCR_ZOOM_MAX - 0.001;
}

function getPdfOcrZoomAnchor(container, page, options) {
  const containerRect = container.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) return null;
  const focalClientX = Number.isFinite(options.focalClientX)
    ? options.focalClientX
    : containerRect.left + containerRect.width / 2;
  const focalClientY = Number.isFinite(options.focalClientY)
    ? options.focalClientY
    : Math.min(containerRect.top + containerRect.height / 2, pageRect.top + pageRect.height / 2);
  return {
    xRatio: clamp((focalClientX - pageRect.left) / pageRect.width, 0, 1),
    yRatio: clamp((focalClientY - pageRect.top) / pageRect.height, 0, 1),
    viewportX: focalClientX - containerRect.left,
    viewportY: focalClientY - containerRect.top
  };
}

function restorePdfOcrZoomAnchor(container, page, anchor) {
  container.scrollLeft = Math.max(0, page.offsetLeft + page.offsetWidth * anchor.xRatio - anchor.viewportX);
  container.scrollTop = Math.max(0, page.offsetTop + page.offsetHeight * anchor.yRatio - anchor.viewportY);
}

function getPdfOcrPageWords(page) {
  const pageWords = Array.isArray(page?.words)
    ? page.words.filter((word) => String(word?.text || "").trim())
    : [];
  if (pageWords.length) return pageWords;

  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const words = lines.flatMap((line) => layoutPdfOcrLineWords(line, page));
  if (words.length) return words;
  return [];
}

export function mapPdfOverlayWordIndexes(pageWords, pageText, lang, algorithm, globalOffset = 0) {
  const overlayWords = (pageWords || []).map((word) => normalizeWord(word?.text || ""));
  const correctedWords = tokenizeText(pageText, lang, algorithm)
    .filter((token) => token.type === "word")
    .map((token) => normalizeWord(token.value));
  const result = new Array(overlayWords.length).fill(null);
  if (overlayWords.length === correctedWords.length
    && overlayWords.every((word, index) => word && word === correctedWords[index])) {
    return overlayWords.map((_, index) => globalOffset + index);
  }
  const columns = correctedWords.length + 1;
  const cells = (overlayWords.length + 1) * columns;
  if (cells > 4_000_000) return result;
  const lengths = new Uint32Array(cells);
  for (let left = overlayWords.length - 1; left >= 0; left -= 1) {
    for (let right = correctedWords.length - 1; right >= 0; right -= 1) {
      const index = left * columns + right;
      lengths[index] = overlayWords[left] && overlayWords[left] === correctedWords[right]
        ? lengths[(left + 1) * columns + right + 1] + 1
        : Math.max(lengths[(left + 1) * columns + right], lengths[index + 1]);
    }
  }
  let left = 0;
  let right = 0;
  while (left < overlayWords.length && right < correctedWords.length) {
    if (overlayWords[left] && overlayWords[left] === correctedWords[right]) {
      result[left] = globalOffset + right;
      left += 1;
      right += 1;
    } else if (lengths[(left + 1) * columns + right] >= lengths[left * columns + right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return result;
}

function layoutPdfOcrLineWords(line, page) {
  const text = String(line?.text || "").trim();
  const runs = splitPdfOcrTextRuns(text);
  if (!runs.length) return [];

  const rect = pdfOcrRect(line, page);
  const spans = measurePdfOcrRuns(text, runs, rect.height) || estimatePdfOcrRuns(text, runs);
  return spans.map((span) => ({
    text: span.text,
    x: rect.x + rect.width * span.startRatio,
    y: rect.y,
    width: Math.max(1, rect.width * span.widthRatio),
    height: rect.height,
    confidence: Number(line?.confidence) || 0
  }));
}

function splitPdfOcrTextRuns(value) {
  const text = String(value || "").trim();
  const runs = [];
  const pattern = /\S+/gu;
  let match = pattern.exec(text);
  while (match) {
    runs.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
    match = pattern.exec(text);
  }
  return runs;
}

function measurePdfOcrRuns(text, runs, lineHeight) {
  const ctx = getPdfOcrMeasureContext();
  if (!ctx) return null;

  const fontSize = Math.max(6, Math.min(160, Number(lineHeight) || 12));
  ctx.font = `${fontSize.toFixed(2)}px ${PDF_OCR_LAYOUT_FONT}`;
  const total = ctx.measureText(text).width;
  if (!Number.isFinite(total) || total <= 0) return null;

  return runs.map((run) => {
    const start = ctx.measureText(text.slice(0, run.start)).width;
    const end = ctx.measureText(text.slice(0, run.end)).width;
    return pdfOcrRunRatio(run, start, Math.max(0.5, end - start), total);
  });
}

function getPdfOcrMeasureContext() {
  if (pdfOcrMeasureContext) return pdfOcrMeasureContext;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  pdfOcrMeasureContext = canvas.getContext("2d");
  return pdfOcrMeasureContext;
}

function estimatePdfOcrRuns(text, runs) {
  const total = Math.max(1, pdfOcrTextWeight(text));
  return runs.map((run) => {
    const start = pdfOcrTextWeight(text.slice(0, run.start));
    const width = Math.max(0.25, pdfOcrTextWeight(text.slice(run.start, run.end)));
    return pdfOcrRunRatio(run, start, width, total);
  });
}

function pdfOcrRunRatio(run, start, width, total) {
  return {
    text: run.text,
    startRatio: clamp(start / total, 0, 1),
    widthRatio: clamp(width / total, 0.001, 1)
  };
}

function pdfOcrTextWeight(text) {
  let total = 0;
  for (const ch of String(text || "")) total += pdfOcrGlyphWeight(ch);
  return total;
}

function pdfOcrGlyphWeight(ch) {
  if (/\s/u.test(ch)) return 0.3;
  if ("ilIj!|'`1".includes(ch)) return 0.45;
  if ("frt.,:;".includes(ch)) return 0.6;
  if ("mwMW@%&".includes(ch)) return 1.35;
  if (/[0-9]/.test(ch)) return 0.9;
  if (/[A-Z]/.test(ch)) return 1.08;
  if (/[\u2E80-\u9FFF]/u.test(ch)) return 1.8;
  if (/[^\p{L}\p{M}]/u.test(ch)) return 0.65;
  return 1;
}

function pdfOcrRect(item, page, current) {
  const pageWidth = Math.max(1, Number(page?.width) || 1);
  const pageHeight = Math.max(1, Number(page?.height) || 1);
  const rect = correctLegacyPdfTextLayerRect({
    x: Number(item?.x) || 0,
    y: Number(item?.y) || 0,
    width: Number(item?.width) || 1,
    height: Number(item?.height) || 1
  }, page, current);
  const x = clamp(rect.x, 0, pageWidth);
  const y = clamp(rect.y, 0, pageHeight);
  const width = clamp(rect.width, 1, pageWidth - x || 1);
  const height = clamp(rect.height, 1, pageHeight - y || 1);
  return { pageWidth, pageHeight, x, y, width, height };
}

function correctLegacyPdfTextLayerRect(rect, page, current) {
  if (!usesLegacyPdfTextLayerBounds(page, current)) return rect;

  const fontHeight = Math.max(1, rect.height / 1.24);
  return {
    ...rect,
    y: rect.y - fontHeight * 0.82,
    height: fontHeight * 1.04
  };
}

function usesLegacyPdfTextLayerBounds(page, current) {
  if (String(page?.boundsVersion || "") === PDF_TEXT_LAYER_BOUNDS_VERSION) return false;
  const engine = String(current?.pdfOcrEngine || "");
  return engine.includes("pdf-text-layer") || engine.includes("pdfium-text-layer");
}

function renderPdfOcrWord(item, page, globalIndex, current, matchedWord = "", pageWordIndex = null) {
  const raw = String(item?.text || "").trim();
  if (!raw) return "";
  const { pageWidth, pageHeight, x, y, width, height } = pdfOcrRect(item, page, current);
  const word = matchedWord || normalizeWord(raw);
  const entry = state.vocab[word];
  const status = entry ? entry.status : "new";
  const selected = state.selectedWord === word ? "selected" : "";
  const color = status === "learning" ? getLearningColor(entry, state.preferences) : "";
  const style = [
    `left:${((x / pageWidth) * 100).toFixed(4)}%`,
    `top:${((y / pageHeight) * 100).toFixed(4)}%`,
    `width:${((width / pageWidth) * 100).toFixed(4)}%`,
    `height:${((height / pageHeight) * 100).toFixed(4)}%`,
    color && `--token-learning-bg:${color}`
  ].filter(Boolean).join(";");

  const indexAttribute = Number.isInteger(globalIndex) ? ` data-word-index="${globalIndex}"` : "";
  const pageIndexAttribute = Number.isInteger(pageWordIndex) ? ` data-pdf-page-word-index="${pageWordIndex}"` : "";
  return `<button class="word-token pdf-ocr-word status-${status} ${selected}" type="button" data-word="${escapeAttribute(word)}"${indexAttribute}${pageIndexAttribute} style="${style}" aria-label="${escapeAttribute(raw)}"></button>`;
}
