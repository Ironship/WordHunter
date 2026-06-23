/**
 * PDF-OCR reader rendering: page image + word overlay, layout estimation,
 * per-page text extraction, word-token emission.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, clamp } from "../utils.js";
import { t } from "../i18n.js";
import { normalizeWord, getTextStats } from "../tokenizer_v2.js";
import { restoreReaderScrollPosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";
import { cacheTotalPages, paginationHtml } from "./pagination.js";
import { renderTrackingSummary } from "./renderer.js";
import { getLearningColor } from "../reader-colors.js";

const PDF_OCR_LAYOUT_FONT = `"Times New Roman", Georgia, serif`;
let pdfOcrMeasureContext = null;

export function isPdfOcrText(text) {
  return Array.isArray(text?.pdfOcrPages) && text.pdfOcrPages.length > 0;
}

export function renderPdfOcrReader(current, scrollPerPageKey, savedPos) {
  const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const stats = getTextStats(current.text, state.vocab, state.preferences.learningLanguage || "en", wordAlgorithm);
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
  saveState();

  const pageIndex = state.readerPage - 1;
  const page = pages[pageIndex] || pages[0] || {};
  els.readerText.dataset.ttsText = getPdfOcrPageText(page);
  const globalOffset = pages.slice(0, pageIndex).reduce((sum, item) => sum + countPdfOcrWords(item), 0);
  const imageName = page.imageName || "";
  const imageUrl = `/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(imageName)}`;
  const wordsHtml = getPdfOcrPageWords(page)
    .map((word, index) => renderPdfOcrWord(word, page, globalOffset + index + 1))
    .join("");

  els.readerText.innerHTML = `
    <div class="pdf-ocr-stage">
      <div class="pdf-ocr-page" style="--pdf-page-width:${Number(page.width) || 1}; --pdf-page-height:${Number(page.height) || 1};">
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
}

function getPdfOcrPageWords(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const words = lines.flatMap((line) => layoutPdfOcrLineWords(line, page));
  if (words.length) return words;
  return Array.isArray(page?.words) ? page.words : [];
}

function getPdfOcrPageText(page) {
  const text = String(page?.text || "").trim();
  if (text) return text;

  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const lineText = lines
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean);
  if (lineText.length) return lineText.join("\n");

  const words = Array.isArray(page?.words) ? page.words : [];
  return words
    .map((word) => String(word?.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

function countPdfOcrWords(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const fromLines = lines.reduce((sum, line) => sum + splitPdfOcrTextRuns(line?.text).length, 0);
  if (fromLines > 0) return fromLines;
  return Array.isArray(page?.words) ? page.words.length : 0;
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

function pdfOcrRect(item, page) {
  const pageWidth = Math.max(1, Number(page?.width) || 1);
  const pageHeight = Math.max(1, Number(page?.height) || 1);
  const x = clamp(Number(item?.x) || 0, 0, pageWidth);
  const y = clamp(Number(item?.y) || 0, 0, pageHeight);
  const width = clamp(Number(item?.width) || 1, 1, pageWidth - x || 1);
  const height = clamp(Number(item?.height) || 1, 1, pageHeight - y || 1);
  return { pageWidth, pageHeight, x, y, width, height };
}

function renderPdfOcrWord(item, page, globalIndex) {
  const raw = String(item?.text || "").trim();
  if (!raw) return "";
  const { pageWidth, pageHeight, x, y, width, height } = pdfOcrRect(item, page);
  const word = normalizeWord(raw);
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

  return `<button class="word-token pdf-ocr-word status-${status} ${selected}" type="button" data-word="${escapeAttribute(word)}" data-word-index="${globalIndex}" style="${style}" aria-label="${escapeAttribute(raw)}">${escapeHtml(raw)}</button>`;
}
