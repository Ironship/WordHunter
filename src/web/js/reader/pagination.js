/**
 * Reader pagination: page totals, page-slice computation, page navigation, pagination HTML.
 * The render pass caches its total; before that, navigation defers clamping to the render pass
 * instead of tokenizing a second time.
 */
import { state, saveState } from "../state.js";
import { escapeHtml } from "../utils.js";
import { renderReader } from "./renderer.js";
import { t } from "../i18n.js";

let _cachedTotalPages = { textId: null, totalPages: 1 };

function countWordTokens(tokens) {
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "word") count++;
  }
  return count;
}

function computeTotalPages(totalWords, wordsPerPage) {
  return wordsPerPage >= 999999 ? 1 : Math.max(1, Math.ceil(totalWords / wordsPerPage));
}

export { countWordTokens, computeTotalPages };

export function cacheTotalPages(textId, totalPages) {
  _cachedTotalPages = { textId, totalPages };
}

function getCachedTotalPages(textId) {
  return _cachedTotalPages.textId === textId ? _cachedTotalPages.totalPages : null;
}

function readerTotalPages() {
  return getCachedTotalPages(state.currentTextId);
}

export function computePageSlice(tokens, readerPage, wordsPerPage) {
  let pageStartIndex = 0;
  let pageEndIndex = tokens.length;
  if (wordsPerPage < 999999) {
    let wordCount = 0;
    let i = 0;
    for (; i < tokens.length; i++) {
      if (wordCount >= (readerPage - 1) * wordsPerPage) {
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
  return { pageStartIndex, pageEndIndex };
}

function applyReaderPage(next) {
  if (next === state.readerPage) return;
  state.readerPage = next;
  if (!state.readerPages) state.readerPages = {};
  if (state.currentTextId) state.readerPages[state.currentTextId] = next;
  saveState();
  renderReader();
}

export function changeReaderPage(delta) {
  if (!state.currentTextId || typeof delta !== "number") return;
  const totalPages = readerTotalPages();
  if (totalPages == null) {
    applyReaderPage(Math.max(1, state.readerPage + delta));
    return;
  }
  if (totalPages <= 1) return;
  const next = Math.min(Math.max(1, state.readerPage + delta), totalPages);
  applyReaderPage(next);
}

export function goToReaderPage(page) {
  if (!state.currentTextId) return;
  const totalPages = readerTotalPages();
  const requested = Math.max(1, Math.round(page) || 1);
  const next = totalPages == null ? requested : Math.min(requested, totalPages);
  applyReaderPage(next);
}

export function paginationHtml(textId, currentPage, totalPages, tFn) {
  return `
    <div class="pagination-controls">
      <button class="secondary-button" id="btn-prev-page" ${currentPage <= 1 ? "disabled" : ""} data-i18n-attr="title=reader.prevPageTitle">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        <kbd style="font-size:0.6rem; padding: 1px 3px; margin-left: 4px;">${escapeHtml(tFn("reader.keyPageUp"))}</kbd>
      </button>
      <span class="page-jump">
        <input type="number" id="page-jump-input" class="page-jump-input" min="1" max="${totalPages}" value="${currentPage}" aria-label="${tFn("reader.pageJumpLabel")}">
        <span class="page-jump-total">/&thinsp;${totalPages}</span>
      </span>
      <button class="secondary-button" id="btn-next-page" ${currentPage >= totalPages ? "disabled" : ""} data-i18n-attr="title=reader.nextPageTitle">
        <kbd style="font-size:0.6rem; padding: 1px 3px; margin-right: 4px;">${escapeHtml(tFn("reader.keyPageDown"))}</kbd>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    </div>
  `;
}
