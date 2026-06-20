/**
 * Reader rendering: tokenization, pagination, chunked HTML building, tracking summary.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, calcStatsPcts, clamp } from "../utils.js";
import { t } from "../i18n.js";
import { normalizeWord, tokenizeText, getTextStats } from "../tokenizer_v2.js";
import { getAllBooks, bookTexts } from "../books.js";
import { restoreReaderScrollPosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";

const PDF_OCR_LAYOUT_FONT = `"Times New Roman", Georgia, serif`;
let pdfOcrMeasureContext = null;

export function getAllTexts() {
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

export function getTextById(id) {
  return getAllTexts().find((text) => text.id === id);
}

export function renderTrackingSummary(stats) {
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

let loadingBook = null;

export function setReaderLoading(book) {
  loadingBook = book;
  renderReader();
}

export function clearReaderLoading() {
  loadingBook = null;
}

export function changeReaderPage(delta) {
  if (!state.currentTextId || typeof delta !== "number") return;
  const totalPages = readerTotalPages();
  if (totalPages <= 1) return;
  const next = Math.min(Math.max(1, state.readerPage + delta), totalPages);
  applyReaderPage(next);
}

export function goToReaderPage(page) {
  if (!state.currentTextId) return;
  const totalPages = readerTotalPages();
  const next = Math.min(Math.max(1, Math.round(page) || 1), totalPages);
  applyReaderPage(next);
}

function readerTotalPages() {
  const current = getTextById(state.currentTextId);
  if (!current) return 1;
  if (isPdfOcrText(current)) return Math.max(1, current.pdfOcrPages.length);
  const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const tokens = tokenizeText(current.text, state.preferences.learningLanguage || "en", wordAlgorithm);
  const totalWords = tokens.filter(tok => tok.type === "word").length;
  const wordsPerPage = Number(state.preferences.wordsPerPage) || 1000;
  return wordsPerPage >= 999999 ? 1 : Math.max(1, Math.ceil(totalWords / wordsPerPage));
}

function applyReaderPage(next) {
  if (next === state.readerPage) return;
  state.readerPage = next;
  if (!state.readerPages) state.readerPages = {};
  if (state.currentTextId) state.readerPages[state.currentTextId] = next;
  saveState();
  renderReader();
}

export function renderReader() {
  if (!els.readerText) return;
  if (loadingBook) {
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
      <div class="reader-loading">
        <div class="spinner" aria-hidden="true"></div>
        <p class="eyebrow">${escapeHtml(t("reader.loadingEyebrow"))}</p>
        <h3>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h3>
        <p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p>
        <div class="loading-bar"><div class="loading-bar-fill"></div></div>
      </div>`;
    if (els.wordPanel) {
      els.wordPanel.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p><h2>${escapeHtml(t("reader.loadingHeading", { title: loadingBook.title }))}</h2><p>${escapeHtml(t("reader.loadingHint"))}</p></div>`;
    }
    els.readerText.dataset.rendering = "0";
    return;
  }
  const texts = getAllTexts();
  const current = getTextById(state.currentTextId);

  if (!current) {
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
  delete els.readerText.dataset.ttsText;

  els.readerText.dataset.rendering = "1";
  const scrollPerPageKey = state.currentTextId ? `${state.currentTextId}-p${state.readerPage}` : null;
  const savedPos = state.readerScrolls?.[current.id] || 0;

  if (isPdfOcrText(current)) {
    renderPdfOcrReader(current, scrollPerPageKey, savedPos);
    return;
  }

  els.readerText.innerHTML = `<div class="reader-loading" style="padding: 2rem; text-align: center;"><div class="spinner" aria-hidden="true" style="margin: 0 auto 1rem;"></div><p class="muted-copy">${escapeHtml(t("reader.loadingHint"))}</p></div>`;

  setTimeout(() => {
    // Defer again so the spinner paint is committed before heavy work
    setTimeout(() => {
    // 1. Statistics
      const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
      const stats = getTextStats(current.text, state.vocab, state.preferences.learningLanguage || "en", wordAlgorithm);
      renderTrackingSummary(stats);
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });

      // 2. Tokenization
      const tokens = tokenizeText(current.text, state.preferences.learningLanguage || "en", wordAlgorithm);
      // Global index of each word in the book (1-based, -1 for non-word)
      const globalWordIdx = new Array(tokens.length).fill(-1);
      for (let i = 0, wc = 0; i < tokens.length; i++) {
        if (tokens[i].type === "word") globalWordIdx[i] = ++wc;
      }
      const wordsPerPage = Number(state.preferences.wordsPerPage) || 1000;
      // Build a list of multi-word phrases for fast matching
      const multiWordVocab = Object.keys(state.vocab)
        .filter(k => k.includes(" "))
        .map(k => ({ key: k, words: k.split(" ") }))
        .sort((a, b) => b.words.length - a.words.length);

      let pageStartIndex = 0;
      let pageEndIndex = tokens.length;
      let totalWords = tokens.filter(t => t.type === "word").length;
      let totalPages = wordsPerPage >= 999999 ? 1 : Math.ceil(totalWords / wordsPerPage);

      if (totalPages < 1) totalPages = 1;

      // Restore saved position for this book
      if (state.readerPages && state.readerPages[current.id]) {
        state.readerPage = state.readerPages[current.id];
      }

      if (state.readerPage > totalPages) state.readerPage = totalPages;
      if (state.readerPage < 1) state.readerPage = 1;

      // Save position in case it was adjusted
      if (!state.readerPages) state.readerPages = {};
      state.readerPages[current.id] = state.readerPage;
      saveState();

      if (wordsPerPage < 999999) {
        let wordCount = 0;
        let i = 0;
        for (; i < tokens.length; i++) {
          if (wordCount >= (state.readerPage - 1) * wordsPerPage) {
            pageStartIndex = i;
            break;
          }
          if (tokens[i].type === "word") wordCount++;
        }
        wordCount = 0;
        for (; i < tokens.length; i++) {
          if (tokens[i].type === "word") wordCount++;
          if (wordCount > wordsPerPage) {
            pageEndIndex = i;
            break;
          }
        }
      }

      const pageTokens = tokens.slice(pageStartIndex, pageEndIndex);
      const CHUNK_SIZE = 500;
      let index = 0;
      els.readerText.innerHTML = "";

      const renderId = Date.now();
      els.readerText.dataset.renderId = renderId;

      function renderNextChunk() {
        if (els.readerText.dataset.renderId !== String(renderId)) return;

        if (index >= pageTokens.length) {
          if (totalPages > 1) {
            els.readerText.insertAdjacentHTML("beforeend", paginationHtml(current.id, state.readerPage, totalPages, t));
          }
          renderWordPanel(current);
          // Restore per-page scroll if available, else fallback to text-level scroll
          const perPageScroll = state.readerScrollsPerPage?.[scrollPerPageKey];
          if (perPageScroll !== undefined) {
            els.readerText.scrollTop = perPageScroll;
          } else {
            const savedScroll = state.readerScrolls?.[current.id];
            if (savedScroll && typeof savedScroll === "object" && savedScroll.readerPage != null && savedScroll.readerPage !== state.readerPage) {
              els.readerText.scrollTop = 0;
            } else {
              restoreReaderScrollPosition(current.id, savedPos);
            }
          }
          updateReaderSelection();
          return;
        }

        let htmlChunk = "";
        let i = index;
        let tokensProcessed = 0;

        while (i < pageTokens.length && tokensProcessed < CHUNK_SIZE) {
          const part = pageTokens[i];
          if (part.type === "image") {
            htmlChunk += `<img src="/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(part.value)}" style="max-width: 100%; height: auto; display: block; margin: 1rem auto; border-radius: 6px;" alt="${escapeHtml(t("reader.imageAlt"))}">`;
            i++;
            tokensProcessed++;
            continue;
          }
          if (part.type === "text") {
            htmlChunk += escapeHtml(part.value);
            i++;
            tokensProcessed++;
            continue;
          }

          const word = normalizeWord(part.value);
          let matchedPhraseKey = null;
          let consumedTokens = 1;

          for (const phrase of multiWordVocab) {
            if (phrase.words[0] === word) {
              let match = true;
              let tokenOffset = 1;
              let wordOffset = 1;
              while (wordOffset < phrase.words.length && i + tokenOffset < pageTokens.length) {
                const nextToken = pageTokens[i + tokenOffset];
                if (nextToken.type === "text") {
                  tokenOffset++;
                  continue;
                }
                if (nextToken.type === "word" && normalizeWord(nextToken.value) === phrase.words[wordOffset]) {
                  wordOffset++;
                  tokenOffset++;
                } else {
                  match = false;
                  break;
                }
              }
              if (match && wordOffset === phrase.words.length) {
                matchedPhraseKey = phrase.key;
                consumedTokens = tokenOffset;
                break;
              }
            }
          }

          let status = "new";
          let selected = "";
          let dataWord = escapeHtml(word);

          if (matchedPhraseKey) {
            const phrEntry = state.vocab[matchedPhraseKey];
            if (phrEntry) {
              status = phrEntry.status;
              selected = state.selectedWord === matchedPhraseKey ? "selected" : "";
              dataWord = escapeHtml(matchedPhraseKey);
            }
          }
          if (!matchedPhraseKey || !Object.hasOwn(state.vocab, matchedPhraseKey)) {
            consumedTokens = 1;
            const entry = state.vocab[word];
            status = entry ? entry.status : "new";
            selected = state.selectedWord === word ? "selected" : "";
          }

          for (let j = 0; j < consumedTokens; j++) {
            const consumedPart = pageTokens[i + j];
            if (consumedPart.type === "text") {
               htmlChunk += escapeHtml(consumedPart.value);
            } else {
               const pSelected = selected || (state.selectedWord === normalizeWord(consumedPart.value) ? "selected" : "");
               const globalIdx = globalWordIdx[pageStartIndex + i + j];
               htmlChunk += `<button class="word-token status-${status} ${pSelected}" type="button" data-word="${dataWord}" data-word-index="${globalIdx}">${escapeHtml(consumedPart.value)}</button>`;
            }
          }

          i += consumedTokens;
          tokensProcessed += consumedTokens;
        }

        els.readerText.insertAdjacentHTML("beforeend", htmlChunk);
        index = i;
        setTimeout(renderNextChunk, 0); // Allows UI to breathe
      }

      setTimeout(renderNextChunk, 0);
    });  // inner setTimeout for spinner paint
  }, 10);
}

function isPdfOcrText(text) {
  return Array.isArray(text?.pdfOcrPages) && text.pdfOcrPages.length > 0;
}

function renderPdfOcrReader(current, scrollPerPageKey, savedPos) {
  const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const stats = getTextStats(current.text, state.vocab, state.preferences.learningLanguage || "en", wordAlgorithm);
  renderTrackingSummary(stats);
  els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });

  const pages = current.pdfOcrPages;
  const totalPages = Math.max(1, pages.length);
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
  const style = [
    `left:${((x / pageWidth) * 100).toFixed(4)}%`,
    `top:${((y / pageHeight) * 100).toFixed(4)}%`,
    `width:${((width / pageWidth) * 100).toFixed(4)}%`,
    `height:${((height / pageHeight) * 100).toFixed(4)}%`
  ].join(";");

  return `<button class="word-token pdf-ocr-word status-${status} ${selected}" type="button" data-word="${escapeAttribute(word)}" data-word-index="${globalIndex}" style="${style}" aria-label="${escapeAttribute(raw)}">${escapeHtml(raw)}</button>`;
}

function paginationHtml(textId, currentPage, totalPages, tFn) {
  return `
    <div class="pagination-controls">
      <button class="secondary-button" id="btn-prev-page" ${currentPage <= 1 ? "disabled" : ""} data-i18n-attr="title=reader.prevPageTitle">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        <kbd style="font-size:0.6rem; padding: 1px 3px; margin-left: 4px;">PgUp</kbd>
      </button>
      <span class="page-jump">
        <input type="number" id="page-jump-input" class="page-jump-input" min="1" max="${totalPages}" value="${currentPage}" aria-label="${tFn("reader.pageJumpLabel")}">
        <span class="page-jump-total">/&thinsp;${totalPages}</span>
      </span>
      <button class="secondary-button" id="btn-next-page" ${currentPage >= totalPages ? "disabled" : ""} data-i18n-attr="title=reader.nextPageTitle">
        <kbd style="font-size:0.6rem; padding: 1px 3px; margin-right: 4px;">PgDn</kbd>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    </div>
  `;
}
