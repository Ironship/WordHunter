/**
 * Reader scroll position save/restore.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";

export function rememberReaderScrollPosition() {
  if (!els.readerText || !state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};

  const scrollTop = Math.max(0, Math.round(els.readerText.scrollTop || 0));
  let wordIndex = null;
  const tokens = els.readerText.querySelectorAll(".word-token");
  const containerRect = els.readerText.getBoundingClientRect();
  for (const token of tokens) {
    const tr = token.getBoundingClientRect();
    if (tr.top < containerRect.bottom && tr.bottom > containerRect.top) {
      const idx = parseInt(token.dataset.wordIndex, 10);
      if (!isNaN(idx)) wordIndex = idx;
      break;
    }
  }

  state.readerScrolls[state.currentTextId] = {
    wordIndex: wordIndex,
    scrollTop: scrollTop,
    readerPage: state.readerPage
  };
  if (state.readerScrollsPerPage && state.readerPage) {
    state.readerScrollsPerPage[`${state.currentTextId}-p${state.readerPage}`] = scrollTop;
  }
  saveState();
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
    if (saved.wordIndex) {
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


