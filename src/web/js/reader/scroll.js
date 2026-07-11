/**
 * Reader scroll position save/restore.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";

function readWordIndex(token) {
  const idx = Number.parseInt(token?.dataset?.wordIndex, 10);
  return Number.isFinite(idx) ? idx : null;
}

function visibleWordIndexFromPoint(container) {
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
      if (!token || !container.contains(token)) continue;
      const idx = readWordIndex(token);
      if (idx !== null) return idx;
    }
  }

  return null;
}

export function rememberReaderScrollPosition({ precise = true, flush = false } = {}) {
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

export function restoreReaderScrollPosition(textId, saved, attempt) {
  const container = els.readerText;
  if (state.currentTextId !== textId || !container) return;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

  // Content hasn't been laid out yet — retry after a tick
  if (maxScroll <= 0 && (attempt || 0) < 8) {
    setTimeout(() => restoreReaderScrollPosition(textId, saved, (attempt || 0) + 1), 60);
    return;
  }

  let target = 0;
  if (saved && typeof saved === "object") {
    // 1. Global word index — most precise
    if (Number.isInteger(saved.wordIndex) && saved.wordIndex >= 0) {
      const token = container.querySelector(`[data-word-index="${saved.wordIndex}"]`);
      if (token) {
        const tr = token.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        if (tr.height > 0) {
          target = Math.round(tr.top - cr.top + container.scrollTop - container.clientHeight / 2 + tr.height / 2);
        }
      }
    }
    // 2. Direct scrollTop as backup
    if (target === 0 && typeof saved.scrollTop === "number" && saved.scrollTop > 0) {
      target = saved.scrollTop;
    }
  } else if (typeof saved === "number" && saved > 0) {
    target = saved;
  }

  container.scrollTop = Math.max(0, Math.min(target, maxScroll));
  container.dataset.rendering = "0";
}
