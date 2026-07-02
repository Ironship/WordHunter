// Reader view: orchestrator — binds events, re-exports from sub-modules.
// Keeps full API compatibility: all imports from "../views/reader.js" still work.

import { bindSidebarResizer } from "../panel-resizer.js";
import { state } from "../state.js";

// Import for local use (bindReaderEvents)
import {
  setReaderSelectionAnchorFromToken,
  clearReaderSelectionRange,
  clearReaderSelection
} from "../reader/selection.js";

import {
  rememberReaderScrollPosition
} from "../reader/scroll.js";

import {
  changeReaderPage,
  goToReaderPage,
  renderReader
} from "../reader/renderer.js";
import {
  adjustPdfOcrZoom,
  getPdfOcrViewMode,
  getPdfOcrZoom,
  pdfOcrZoomStep,
  resetPdfOcrZoom,
  setPdfOcrViewMode,
  setPdfOcrZoom
} from "../reader/pdf-ocr-renderer.js";

// Re-export the public reader API used by the rest of the app.
export {
  getReaderSelectionText,
  setReaderSelectionAnchorFromToken,
  clearReaderSelectionRange,
  clearReaderSelection,
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
    let lastWordPanelInteractionAt = 0;
    const rememberWordPanelInteraction = () => {
      lastWordPanelInteractionAt = Date.now();
    };
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
    let swipeStart = null;
    const beginSwipe = (clientX, clientY, target) => {
      if (target?.closest?.(".pagination-controls, input, textarea, select")) return;
      swipeStart = { x: clientX, y: clientY };
    };
    const finishSwipe = (clientX, clientY) => {
      if (!swipeStart) return;
      const dx = clientX - swipeStart.x;
      const dy = clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) < 80 || Math.abs(dy) > 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      clearReaderSelection(false);
      changeReaderPage(dx < 0 ? 1 : -1);
    };
    let pdfPinch = null;
    const isPdfOcrGestureTarget = (target) => getPdfOcrViewMode() === "overlay" && Boolean(target?.closest?.(".pdf-ocr-page, .pdf-ocr-stage, .pdf-ocr-toolbar"));
    const shouldReservePdfPan = (target) => isPdfOcrGestureTarget(target) && getPdfOcrZoom() > 1.01;
    const touchDistance = (first, second) => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    const touchMidpoint = (first, second) => ({
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2
    });
    const beginPdfPinch = (event) => {
      if (event.touches.length < 2 || !isPdfOcrGestureTarget(event.target)) return false;
      const [first, second] = event.touches;
      pdfPinch = {
        distance: Math.max(1, touchDistance(first, second)),
        zoom: getPdfOcrZoom()
      };
      swipeStart = null;
      return true;
    };
    const updatePdfPinch = (event) => {
      if (!pdfPinch || event.touches.length < 2) return false;
      const [first, second] = event.touches;
      const midpoint = touchMidpoint(first, second);
      const nextZoom = pdfPinch.zoom * (touchDistance(first, second) / pdfPinch.distance);
      setPdfOcrZoom(nextZoom, { focalClientX: midpoint.x, focalClientY: midpoint.y, commit: false });
      return true;
    };
    els.readerText.addEventListener("touchstart", (event) => {
      if (beginPdfPinch(event)) {
        event.preventDefault();
        return;
      }
      const touch = event.touches[0];
      if (touch && !shouldReservePdfPan(event.target)) beginSwipe(touch.clientX, touch.clientY, event.target);
    }, { passive: false });
    els.readerText.addEventListener("touchmove", (event) => {
      if (!updatePdfPinch(event)) return;
      event.preventDefault();
    }, { passive: false });
    els.readerText.addEventListener("touchend", (event) => {
      if (pdfPinch) {
        if (event.touches.length >= 2) return;
        pdfPinch = null;
        swipeStart = null;
        return;
      }
      const touch = event.changedTouches[0];
      if (touch) finishSwipe(touch.clientX, touch.clientY);
    }, { passive: true });
    els.readerText.addEventListener("wheel", (event) => {
      if ((!event.ctrlKey && !event.metaKey) || !isPdfOcrGestureTarget(event.target)) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      adjustPdfOcrZoom(direction * pdfOcrZoomStep(), { focalClientX: event.clientX, focalClientY: event.clientY });
    }, { passive: false });
    els.readerText.addEventListener("change", (event) => {
      const pageInput = event.target.closest("#page-jump-input");
      if (!pageInput) return;
      event.preventDefault();
      event.stopPropagation();
      goToReaderPage(Number(pageInput.value));
    });
    els.readerText.addEventListener("click", async (event) => {
      const zoomBtn = event.target.closest("[data-pdf-zoom]");
      if (zoomBtn) {
        event.preventDefault();
        event.stopPropagation();
        const action = zoomBtn.dataset.pdfZoom;
        const step = pdfOcrZoomStep();
        if (action === "in") adjustPdfOcrZoom(step);
        else if (action === "out") adjustPdfOcrZoom(-step);
        else if (action === "reset") resetPdfOcrZoom();
        return;
      }
      const pdfViewModeBtn = event.target.closest("[data-pdf-view-mode]");
      if (pdfViewModeBtn) {
        event.preventDefault();
        event.stopPropagation();
        clearReaderSelection(false);
        setPdfOcrViewMode(pdfViewModeBtn.dataset.pdfViewMode);
        renderReader();
        return;
      }
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
        clearReaderSelection(true);
      }
    });
    els.readerText.addEventListener("focusout", () => {
      setTimeout(() => {
        if (Date.now() - lastWordPanelInteractionAt < 700) return;
        const active = document.activeElement;
        if (!active) return;
        if (active.closest?.("#reader-text .word-token, #word-panel")) return;
        clearReaderSelection(true);
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
    els.wordPanel.addEventListener("pointerdown", rememberWordPanelInteraction);
    els.wordPanel.addEventListener("touchstart", rememberWordPanelInteraction, { passive: true });
    els.wordPanel.addEventListener("focusin", rememberWordPanelInteraction);
    els.wordPanel.addEventListener("click", async (event) => {
      rememberWordPanelInteraction();
      const suggestBtn = event.target.closest("[data-suggest-word]");
      if (suggestBtn) {
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        selectWord(suggestBtn.dataset.suggestWord, normalizeWord, true);
      }
    });
  });
}
