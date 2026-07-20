/**
 * Reader scroll position save/restore.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";

let scrollRestoreGeneration = 0;

export interface ReaderScrollPosition {
  wordIndex: number | null;
  scrollTop: number;
  readerPage: number;
}

export interface RememberReaderScrollOptions {
  precise?: boolean;
  flush?: boolean;
}

function readWordIndex(token: HTMLElement | null): number | null {
  const idx = Number.parseInt(token?.dataset.wordIndex || "", 10);
  return Number.isFinite(idx) ? idx : null;
}

function visibleWordIndexFromPoint(container: HTMLElement): number | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;

  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const xs = [
    rect.left + 20,
    rect.left + rect.width * 0.33,
    rect.left + rect.width * 0.5,
    rect.right - 20
  ].filter((x) => x > rect.left && x < rect.right);
  const ys = [
    rect.top + 20,
    rect.top + rect.height * 0.25,
    rect.top + rect.height * 0.5
  ].filter((y) => y > rect.top && y < rect.bottom);

  for (const y of ys) {
    for (const x of xs) {
      const token = document.elementFromPoint(x, y)?.closest?.(".word-token");
      if (!(token instanceof HTMLElement) || !container.contains(token)) continue;
      const idx = readWordIndex(token);
      if (idx !== null) return idx;
    }
  }

  for (const token of container.querySelectorAll<HTMLElement>(".word-token[data-word-index]")) {
    const tokenRect = token.getBoundingClientRect();
    if (tokenRect.bottom <= rect.top || tokenRect.top >= rect.bottom) continue;
    if (tokenRect.right <= rect.left || tokenRect.left >= rect.right) continue;
    const idx = readWordIndex(token);
    if (idx !== null) return idx;
  }

  return null;
}

export function rememberReaderScrollPosition({ precise = true, flush = false }: RememberReaderScrollOptions = {}): void {
  if (!els.readerText || !state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};

  const scrollTop = Math.max(0, Math.round(els.readerText.scrollTop || 0));
  const wordIndex = precise ? visibleWordIndexFromPoint(els.readerText) : null;
  const previous = state.readerScrolls[state.currentTextId];
  const next = {
    wordIndex,
    scrollTop,
    readerPage: state.readerPage
  };
  const perPageKey = state.readerPage ? `${state.currentTextId}-p${state.readerPage}` : null;
  const previousPerPage = perPageKey ? state.readerScrollsPerPage?.[perPageKey] : undefined;

  if (
    previous
    && previous.wordIndex === next.wordIndex
    && previous.scrollTop === next.scrollTop
    && previous.readerPage === next.readerPage
    && previousPerPage === scrollTop
  ) {
    if (flush) saveUiState();
    return;
  }

  state.readerScrolls[state.currentTextId] = next;
  if (state.readerScrollsPerPage && perPageKey) {
    state.readerScrollsPerPage[perPageKey] = scrollTop;
  }
  if (flush) saveUiState();
}

export function restoreReaderScrollPosition(
  textId: string,
  saved: unknown,
  attempt = 0,
  expectedPage = state.readerPage,
  expectedGeneration = ++scrollRestoreGeneration
): void {
  const container = els.readerText as HTMLElement | null;
  if (
    expectedGeneration !== scrollRestoreGeneration
    || state.currentTextId !== textId
    || state.readerPage !== expectedPage
    || !container
  ) return;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

  // Content hasn't been laid out yet — retry after a tick
  if (maxScroll <= 0 && attempt < 8) {
    setTimeout(() => restoreReaderScrollPosition(textId, saved, attempt + 1, expectedPage, expectedGeneration), 60);
    return;
  }

  let target = 0;
  let anchoredToWord = false;
  if (saved && typeof saved === "object") {
    const position = saved as Partial<ReaderScrollPosition>;
    // 1. Global word index — most precise
    if (Number.isInteger(position.wordIndex) && position.wordIndex >= 0) {
      const token = container.querySelector<HTMLElement>(`[data-word-index="${position.wordIndex}"]`);
      if (token) {
        const tr = token.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        if (tr.height > 0) {
          target = Math.round(tr.top - cr.top + container.scrollTop - container.clientHeight / 2 + tr.height / 2);
          anchoredToWord = true;
        }
      }
    }
    // 2. Direct scrollTop as backup
    if (!anchoredToWord && typeof position.scrollTop === "number" && position.scrollTop > 0) {
      target = position.scrollTop;
    }
  } else if (typeof saved === "number" && saved > 0) {
    target = saved;
  }

  container.scrollTop = Math.max(0, Math.min(target, maxScroll));
  container.dataset.rendering = "0";
}

export function restoreReaderPagePosition(textId: string, perPageKey: string | null, saved: unknown): void {
  const restoreGeneration = ++scrollRestoreGeneration;
  const container = els.readerText as HTMLElement | null;
  if (state.currentTextId !== textId || !container) return;
  const position = saved && typeof saved === "object" ? saved as Partial<ReaderScrollPosition> : null;
  if (position && position.readerPage === state.readerPage) {
    restoreReaderScrollPosition(textId, position, 0, state.readerPage, restoreGeneration);
    return;
  }
  const perPageScroll = perPageKey ? state.readerScrollsPerPage?.[perPageKey] : undefined;
  if (typeof perPageScroll === "number") {
    container.scrollTop = Math.max(0, perPageScroll);
    container.dataset.rendering = "0";
    return;
  }
  if (position?.readerPage != null && position.readerPage !== state.readerPage) {
    container.scrollTop = 0;
    container.dataset.rendering = "0";
    return;
  }
  restoreReaderScrollPosition(textId, saved, 0, state.readerPage, restoreGeneration);
}
