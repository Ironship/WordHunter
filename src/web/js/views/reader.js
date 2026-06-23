// Reader view: orchestrator — binds events, re-exports from sub-modules.
// Keeps full API compatibility: all imports from "../views/reader.js" still work.

import { bindSidebarResizer } from "../panel-resizer.js";
import { state } from "../state.js";

// Import for local use (bindReaderEvents)
import {
  setReaderSelectionAnchorFromToken,
  clearReaderSelectionRange
} from "../reader/selection.js";

import {
  rememberReaderScrollPosition
} from "../reader/scroll.js";

import {
  changeReaderPage,
  goToReaderPage
} from "../reader/renderer.js";

// Re-export the public reader API used by the rest of the app.
export {
  getReaderSelectionText,
  setReaderSelectionAnchorFromToken,
  clearReaderSelectionRange,
  extendReaderSelection,
  updateReaderSelection
} from "../reader/selection.js";

export {
  rememberReaderScrollPosition
} from "../reader/scroll.js";

export {
  getTextById,
  renderReader,
  setReaderLoading,
  clearReaderLoading
} from "../reader/renderer.js";

export {
  renderWordPanel,
  updateWordStatusInReader
} from "../reader/word-panel.js";

// --- Orchestrator: event binding -------------------------------------------

export function bindReaderEvents() {
  import("../dom.js").then(({ els }) => {
    bindSidebarResizer(els.readerSidebarResizer, {
      preference: "readerSidebarWidth", cssVariable: "--reader-sidebar-width",
      defaultWidth: 380, minWidth: 300, maxWidth: 720, minMainWidth: 420,
      sidebarSelector: ".reader-sidebar-wrapper"
    });
    els.textSelect.addEventListener("change", async () => {
      const actions = await import("../book-actions.js");
      actions.openBook(els.textSelect.value);
    });
    let readerScrollSaveTimer = null;
    els.readerText.addEventListener("scroll", () => {
      if (els.readerText.dataset.rendering === "1") return;
      if (state.currentView !== "reader" || !state.currentTextId) return;
      clearTimeout(readerScrollSaveTimer);
      readerScrollSaveTimer = setTimeout(() => {
        const last = state.readerScrolls?.[state.currentTextId];
        if (last && last.readerPage != null && last.readerPage !== state.readerPage) return;
        rememberReaderScrollPosition();
      }, 150);
    }, { passive: true });
    els.readerText.addEventListener("change", (event) => {
      const pageInput = event.target.closest("#page-jump-input");
      if (!pageInput) return;
      event.preventDefault();
      event.stopPropagation();
      goToReaderPage(Number(pageInput.value));
    });
    els.readerText.addEventListener("click", async (event) => {
      const prevBtn = event.target.closest("#btn-prev-page");
      if (prevBtn && !prevBtn.disabled) {
        event.preventDefault();
        event.stopPropagation();
        changeReaderPage(-1);
        return;
      }
      const nextBtn = event.target.closest("#btn-next-page");
      if (nextBtn && !nextBtn.disabled) {
        event.preventDefault();
        event.stopPropagation();
        changeReaderPage(1);
        return;
      }
      if(event.target.classList.contains("word-token")) window.lastActiveToken = event.target;
      const token = event.target.closest(".word-token");
      if (token) {
        event.stopPropagation();
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        const { state } = await import("../state.js");
        let wordToSelect = token.dataset.word;

        if (event.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
          wordToSelect = state.selectedWord + " " + wordToSelect;
        } else {
          setReaderSelectionAnchorFromToken(token);
        }

        selectWord(wordToSelect, normalizeWord);
      } else {
        clearReaderSelectionRange(true);
      }
    });
    els.readerText.addEventListener("focusout", () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active) return;
        if (active.closest?.("#reader-text .word-token, #word-panel")) return;
        clearReaderSelectionRange(true);
      }, 150);
    });
    els.readerText.addEventListener("keydown", async (event) => {
      if (event.key === "5") {
        const suggestBtn = els.wordPanel.querySelector("[data-suggest-word]");
        if (suggestBtn) {
          event.preventDefault();
          suggestBtn.click();
        }
        return;
      }

      if (event.ctrlKey) return;
      if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
      const token = event.target.closest(".word-token");
      if (!token) return;

      const { state } = await import("../state.js");
      const isSpace = event.key === " " || event.key === "spacebar" || event.code === "Space";

      if (isSpace && state.readerSelectionRange && state.selectedWord !== token.dataset.word) {
        return;
      }

      if (isSpace && state.selectedWord === token.dataset.word) {
        return;
      }

      event.preventDefault();
      const { selectWord } = await import("../vocab-actions.js");
      const { normalizeWord } = await import("../tokenizer_v2.js");
      let wordToSelect = token.dataset.word;

      if (event.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
          wordToSelect = state.selectedWord + " " + wordToSelect;
      } else {
          setReaderSelectionAnchorFromToken(token);
      }

      selectWord(wordToSelect, normalizeWord);
    });

    // Handle smart suggestion click
    els.wordPanel.addEventListener("click", async (event) => {
      const suggestBtn = event.target.closest("[data-suggest-word]");
      if (suggestBtn) {
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        selectWord(suggestBtn.dataset.suggestWord, normalizeWord, true);
      }
    });
  });
}
