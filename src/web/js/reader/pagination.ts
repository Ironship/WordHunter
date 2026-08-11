/**
 * Reader pagination: page totals, page-slice computation, page navigation, pagination HTML.
 * The render pass caches its total; before that, navigation defers clamping to the render pass
 * instead of tokenizing a second time.
 */
import { state, saveUiState } from "../state.js";
import { escapeAttribute, escapeHtml } from "../utils.js";
import { renderReader } from "./renderer.js";
import { requestReaderPageFocus } from "./focus.js";
import type { TextToken } from "../tokenizer_v2.js";

interface PageSlice {
  pageStartIndex: number;
  pageEndIndex: number;
}

/**
 * Hard ceiling for one rendered page. "Whole book" (999999) would build a DOM
 * with hundreds of thousands of word-token buttons and freeze the UI for
 * minutes on large books, so it is clamped to this many words per page.
 */
const MAX_WORDS_PER_PAGE = 10000;

export function effectiveWordsPerPage(preferred: number): number {
  return Math.min(Math.max(1, Math.trunc(preferred) || 1), MAX_WORDS_PER_PAGE);
}

let _cachedTotalPages: { textId: string | null; totalPages: number } = { textId: null, totalPages: 1 };

function countWordTokens(tokens: readonly TextToken[]): number {
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "word") count++;
  }
  return count;
}

function computeTotalPages(totalWords: number, wordsPerPage: number): number {
  return wordsPerPage >= 999999 ? 1 : Math.max(1, Math.ceil(totalWords / wordsPerPage));
}

export { countWordTokens, computeTotalPages };

export function cacheTotalPages(textId: string, totalPages: number): void {
  _cachedTotalPages = { textId, totalPages };
}

function getCachedTotalPages(textId: string | null): number | null {
  return _cachedTotalPages.textId === textId ? _cachedTotalPages.totalPages : null;
}

function readerTotalPages(): number | null {
  return getCachedTotalPages(state.currentTextId);
}

export function computeIndexedPageSlice(
  tokenCount: number,
  wordTokenIndexes: readonly number[],
  readerPage: number,
  wordsPerPage: number
): PageSlice {
  const limit = effectiveWordsPerPage(wordsPerPage);
  const startWord = Math.max(0, readerPage - 1) * limit;
  return {
    pageStartIndex: startWord === 0 ? 0 : wordTokenIndexes[startWord] ?? tokenCount,
    pageEndIndex: wordTokenIndexes[startWord + limit] ?? tokenCount
  };
}

function applyReaderPage(next: number): void {
  if (next === state.readerPage) return;
  state.readerPage = next;
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  window.lastActiveToken = null;
  if (!state.readerPages) state.readerPages = {};
  if (state.currentTextId) state.readerPages[state.currentTextId] = next;
  saveUiState();
  requestReaderPageFocus();
  renderReader();
}

export function changeReaderPage(delta: number): void {
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

export function goToReaderPage(page: number): void {
  if (!state.currentTextId) return;
  const totalPages = readerTotalPages();
  const requested = Math.max(1, Math.round(page) || 1);
  const next = totalPages == null ? requested : Math.min(requested, totalPages);
  applyReaderPage(next);
}

export function paginationHtml(textId: string, currentPage: number, totalPages: number, tFn: (key: string) => string): string {
  return `
    <div class="pagination-controls">
      <button class="secondary-button" id="btn-prev-page" ${currentPage <= 1 ? "disabled" : ""} title="${escapeAttribute(tFn("reader.prevPageTitle"))}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        <kbd class="page-badge">${escapeHtml(tFn("reader.keyPageUp"))}</kbd>
      </button>
      <span class="page-jump">
        <input type="number" id="page-jump-input" class="page-jump-input" min="1" max="${totalPages}" value="${currentPage}" aria-label="${escapeAttribute(tFn("reader.pageJumpLabel"))}">
        <span class="page-jump-total">/&thinsp;${totalPages}</span>
      </span>
      <button class="secondary-button" id="btn-next-page" ${currentPage >= totalPages ? "disabled" : ""} title="${escapeAttribute(tFn("reader.nextPageTitle"))}">
        <kbd class="page-badge-r">${escapeHtml(tFn("reader.keyPageDown"))}</kbd>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
    </div>
  `;
}
