// Reader view: event orchestrator.

import { bindSidebarResizer } from "../panel-resizer.js";
import { registerFrontendStateFlusher, state } from "../state.js";

import { setReaderSelectionAnchorFromToken, clearReaderSelectionRange, clearReaderSelection } from "../reader/selection.js";

import { rememberReaderScrollPosition } from "../reader/scroll.js";
import { navigateReaderWord } from "../reader/word-navigation.js";

import { changeReaderPage, goToReaderPage, renderReader } from "../reader/renderer.js";
import {
  adjustPdfOcrZoom,
  getPdfOcrViewMode,
  getPdfOcrZoom,
  pdfOcrZoomStep,
  resetPdfOcrZoom,
  setPdfOcrViewMode,
  setPdfOcrZoom
} from "../reader/pdf-ocr-renderer.js";

// --- Orchestrator: event binding -------------------------------------------

export function bindReaderEvents() {
  import("../dom.js").then(({ els }) => {
    let lastWordPanelInteractionAt = 0;
    let pdfWordClickTimer = null;
    const rememberWordPanelInteraction = () => {
      lastWordPanelInteractionAt = Date.now();
    };
    const selectReaderToken = async (token, options = {}) => {
      if (!token?.isConnected) return;
      if (options.openPanel && document.documentElement.classList.contains("pocket-mode")) {
        document.documentElement.classList.add("pocket-word-panel-open");
      }
      window.lastActiveToken = token;
      const { selectWord } = await import("../vocab-actions.js");
      const { normalizeWord } = await import("../tokenizer_v2.js");
      let wordToSelect = token.dataset.word;
      if (options.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
        wordToSelect = state.selectedWord + " " + wordToSelect;
      } else {
        setReaderSelectionAnchorFromToken(token);
      }
      const wordIndex = options.ctrlKey ? state.selectedWordIndex : Number(token.dataset.wordIndex);
      selectWord(wordToSelect, normalizeWord, false, wordIndex);
    };
    const openCurrentPdfCorrection = async (wordIndex = null) => {
      const { getTextById } = await import("../reader/renderer.js");
      const current = getTextById(state.currentTextId);
      const { openPdfOcrCorrection } = await import("../reader/ocr-correction.js");
      return openPdfOcrCorrection(current, Math.max(0, state.readerPage - 1), {
        wordIndex,
        algorithm: state.preferences.wordDetectionAlgorithm || "modern"
      });
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
    els.readerPreviousWord?.addEventListener("click", () => navigateReaderWord(-1));
    els.readerNextWord?.addEventListener("click", () => navigateReaderWord(1));
    let readerScrollSaveTimer = null;
    registerFrontendStateFlusher(() => {
      clearTimeout(readerScrollSaveTimer);
      readerScrollSaveTimer = null;
      if (state.currentView === "reader" && state.currentTextId) rememberReaderScrollPosition({ precise: true, flush: true });
    });
    els.readerText.addEventListener("scroll", () => {
      if (els.readerText.dataset.rendering === "1") return;
      if (state.currentView !== "reader" || !state.currentTextId) return;
      clearTimeout(readerScrollSaveTimer);
      readerScrollSaveTimer = setTimeout(() => {
        const last = state.readerScrolls?.[state.currentTextId];
        if (last && last.readerPage != null && last.readerPage !== state.readerPage) return;
        const scrollTop = Math.max(0, Math.round(els.readerText.scrollTop || 0));
        if (last && last.readerPage === state.readerPage && Math.abs((last.scrollTop || 0) - scrollTop) < 2) return;
        rememberReaderScrollPosition({ precise: false });
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
      const pdfCorrectBtn = event.target.closest("[data-pdf-correct]");
      if (pdfCorrectBtn) {
        event.preventDefault();
        event.stopPropagation();
        if (pdfCorrectBtn.disabled) return;
        pdfCorrectBtn.disabled = true;
        try {
          if (await openCurrentPdfCorrection()) {
            clearReaderSelection(false);
            renderReader();
            requestAnimationFrame(() => els.readerText.querySelector("[data-pdf-correct]")?.focus());
          }
        } finally {
          if (pdfCorrectBtn.isConnected) pdfCorrectBtn.disabled = false;
        }
        return;
      }
      const pdfSentenceBtn = event.target.closest("[data-pdf-correct-sentence]");
      if (pdfSentenceBtn) {
        event.preventDefault();
        event.stopPropagation();
        const wordIndex = Number(pdfSentenceBtn.dataset.pdfPageWordIndex);
        if (pdfSentenceBtn.disabled || !Number.isInteger(wordIndex)) return;
        pdfSentenceBtn.disabled = true;
        try {
          if (await openCurrentPdfCorrection(wordIndex)) {
            clearReaderSelection(false);
            renderReader();
            requestAnimationFrame(() => els.readerText.querySelector("[data-pdf-correct-sentence]")?.focus());
          }
        } finally {
          if (pdfSentenceBtn.isConnected) pdfSentenceBtn.disabled = false;
        }
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
      const token = event.target.closest(".word-token");
      if (token) {
        event.stopPropagation();
        if (token.classList.contains("pdf-ocr-word") && event.detail > 0) {
          clearTimeout(pdfWordClickTimer);
          pdfWordClickTimer = setTimeout(() => {
            pdfWordClickTimer = null;
            selectReaderToken(token, { ctrlKey: event.ctrlKey, openPanel: true });
          }, 220);
        } else {
          await selectReaderToken(token, { ctrlKey: event.ctrlKey, openPanel: true });
        }
      } else {
        clearReaderSelection(true);
      }
    });
    els.readerText.addEventListener("dblclick", async (event) => {
      const token = event.target.closest(".pdf-ocr-word[data-pdf-page-word-index]");
      if (!token) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(pdfWordClickTimer);
      pdfWordClickTimer = null;
      const wordIndex = Number(token.dataset.pdfPageWordIndex);
      if (!Number.isInteger(wordIndex)) return;
      if (await openCurrentPdfCorrection(wordIndex)) {
        clearReaderSelection(false);
        renderReader();
      }
    });
    els.readerText.addEventListener("focusout", () => {
      setTimeout(() => {
        if (document.documentElement.classList.contains("pocket-mode")) return;
        if (Date.now() - lastWordPanelInteractionAt < 700) return;
        const active = document.activeElement;
        if (!active) return;
        if (active.closest?.("#reader-text .word-token, #word-panel")) return;
        clearReaderSelection(true);
      }, 150);
    });
    els.readerText.addEventListener("keydown", async (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
      const token = event.target.closest(".word-token");
      if (!token) return;

      const isSpace = event.key === " " || event.key === "spacebar" || event.code === "Space";

      if (event.key === "Enter" && state.selectedWord && document.querySelector("[data-in-text-answer]")) {
        return;
      }

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

      const wordIndex = event.ctrlKey ? state.selectedWordIndex : Number(token.dataset.wordIndex);
      selectWord(wordToSelect, normalizeWord, false, wordIndex);
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
        selectWord(suggestBtn.dataset.suggestWord, normalizeWord, true, state.selectedWordIndex);
      }
    });
  });
}
