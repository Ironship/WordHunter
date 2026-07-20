// Reader view: event orchestrator.

import { bindSidebarResizer } from "../panel-resizer.js";
import { registerFrontendStateFlusher, state } from "../state.js";

import { setReaderSelectionAnchorFromToken, clearReaderSelectionRange, clearReaderSelection } from "../reader/selection.js";

import { rememberReaderScrollPosition } from "../reader/scroll.js";
import { bindReaderBookmarkEvents } from "../reader/bookmarks.js";
import { navigateReaderWord } from "../reader/word-navigation.js";
import { refreshPocketWordPanelSheet } from "../platform.js";

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

interface ReaderTokenOptions {
  ctrlKey?: boolean;
  openPanel?: boolean;
}

interface SwipePoint {
  x: number;
  y: number;
  card?: boolean;
  touchId?: number;
}

interface PdfPinchState {
  distance: number;
  zoom: number;
}

const WORD_CARD_SWIPE_DISTANCE = 56;
const WORD_CARD_SWIPE_AXIS_RATIO = 1.2;

export function bindReaderEvents(): void {
  import("../dom.js").then(({ els }) => {
    const readerText = els.readerText;
    const textSelect = els.textSelect;
    const wordPanel = els.wordPanel;
    if (!(readerText instanceof HTMLElement)
      || !(textSelect instanceof HTMLSelectElement)
      || !(wordPanel instanceof HTMLElement)) return;
    bindReaderBookmarkEvents();

    let lastWordPanelInteractionAt = 0;
    let pdfWordClickTimer: number | null = null;
    const rememberWordPanelInteraction = () => {
      lastWordPanelInteractionAt = Date.now();
    };
    const selectReaderToken = async (token: HTMLElement, options: ReaderTokenOptions = {}): Promise<void> => {
      if (!token?.isConnected) return;
      const openPocketPanel = options.openPanel && document.documentElement.classList.contains("pocket-mode");
      if (openPocketPanel) {
        document.documentElement.classList.add("pocket-word-panel-open");
      }
      window.lastActiveToken = token;
      const { selectWord } = await import("../vocab-actions.js");
      const { normalizeWord } = await import("../tokenizer_v2.js");
      let wordToSelect = token.dataset.word;
      if (!wordToSelect) return;
      if (options.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
        wordToSelect = state.selectedWord + " " + wordToSelect;
      } else {
        setReaderSelectionAnchorFromToken(token);
      }
      const wordIndex = options.ctrlKey ? state.selectedWordIndex : Number(token.dataset.wordIndex);
      selectWord(wordToSelect, normalizeWord, false, wordIndex);
      if (openPocketPanel) refreshPocketWordPanelSheet();
    };
    const openCurrentPdfCorrection = async (wordIndex: number | null = null): Promise<boolean> => {
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
    textSelect.addEventListener("change", async () => {
      const actions = await import("../book-actions.js");
      actions.openBook(textSelect.value);
    });
    els.readerPreviousWord?.addEventListener("click", () => navigateReaderWord(-1));
    els.readerNextWord?.addEventListener("click", () => navigateReaderWord(1));
    let readerScrollSaveTimer: number | null = null;
    registerFrontendStateFlusher(() => {
      clearTimeout(readerScrollSaveTimer);
      readerScrollSaveTimer = null;
      if (state.currentView === "reader" && state.currentTextId) rememberReaderScrollPosition({ precise: true, flush: true });
    });
    readerText.addEventListener("scroll", () => {
      if (readerText.dataset.rendering === "1") return;
      if (state.currentView !== "reader" || !state.currentTextId) return;
      clearTimeout(readerScrollSaveTimer);
      readerScrollSaveTimer = setTimeout(() => {
        const last = state.readerScrolls?.[state.currentTextId];
        if (last && last.readerPage != null && last.readerPage !== state.readerPage) return;
        const scrollTop = Math.max(0, Math.round(readerText.scrollTop || 0));
        if (last && last.readerPage === state.readerPage && Math.abs((last.scrollTop || 0) - scrollTop) < 2) {
          return;
        }
        rememberReaderScrollPosition({ precise: true, flush: true });
      }, 150);
    }, { passive: true });
    let swipeStart: SwipePoint | null = null;
    let suppressSwipeClickUntil = 0;
    let wordCardResetTimer = 0;
    const isWordPanelOpen = (): boolean => {
      const root = document.documentElement;
      if (!state.selectedWord) return false;
      return root.classList.contains("pocket-mode")
        ? root.classList.contains("pocket-word-panel-open")
        : !root.classList.contains("reader-word-panel-hidden");
    };
    const isHorizontalSwipe = (
      dx: number,
      dy: number,
      minDistance: number,
      axisRatio: number,
      maxVerticalDistance = Number.POSITIVE_INFINITY
    ): boolean => Math.abs(dx) >= minDistance
      && Math.abs(dy) <= maxVerticalDistance
      && Math.abs(dx) >= Math.abs(dy) * axisRatio;
    const resetWordCardDrag = (animate: boolean): void => {
      window.clearTimeout(wordCardResetTimer);
      wordPanel.classList.remove("word-panel-card-dragging", "word-panel-card-drag-left", "word-panel-card-drag-right");
      if (animate && wordPanel.style.getPropertyValue("--word-card-drag-x")) {
        wordPanel.classList.add("word-panel-card-snapback");
        wordCardResetTimer = window.setTimeout(() => {
          wordPanel.classList.remove("word-panel-card-snapback");
          wordPanel.style.removeProperty("--word-card-drag-x");
          wordPanel.style.removeProperty("--word-card-drag-rotate");
        }, 220);
        return;
      }
      wordPanel.classList.remove("word-panel-card-snapback");
      wordPanel.style.removeProperty("--word-card-drag-x");
      wordPanel.style.removeProperty("--word-card-drag-rotate");
    };
    const beginSwipe = (
      clientX: number,
      clientY: number,
      target: EventTarget | null,
      card = false,
      touchId?: number
    ): void => {
      if (card && wordPanel.dataset.wordCardTransition) return;
      if (target instanceof Element) {
        if (target.closest(".pagination-controls, a, input, textarea, select, [contenteditable]")) return;
        if (!card && target.closest("button:not(.word-token)")) return;
      }
      swipeStart = { x: clientX, y: clientY, card, touchId };
    };
    const updateSwipe = (clientX: number, clientY: number, event: TouchEvent): void => {
      if (!swipeStart?.card) return;
      const dx = clientX - swipeStart.x;
      const dy = clientY - swipeStart.y;
      if (!isHorizontalSwipe(dx, dy, 10, WORD_CARD_SWIPE_AXIS_RATIO)) return;
      event.preventDefault();
      window.clearTimeout(wordCardResetTimer);
      const limitedDx = Math.max(-window.innerWidth * 0.72, Math.min(window.innerWidth * 0.72, dx));
      wordPanel.classList.remove("word-panel-card-snapback", "word-panel-card-drag-left", "word-panel-card-drag-right");
      wordPanel.classList.add("word-panel-card-dragging", limitedDx < 0 ? "word-panel-card-drag-left" : "word-panel-card-drag-right");
      wordPanel.style.setProperty("--word-card-drag-x", `${limitedDx}px`);
      wordPanel.style.setProperty("--word-card-drag-rotate", limitedDx < 0 ? "-1.5deg" : "1.5deg");
    };
    const finishSwipe = (clientX: number, clientY: number): void => {
      if (!swipeStart) return;
      const dx = clientX - swipeStart.x;
      const dy = clientY - swipeStart.y;
      const card = swipeStart.card;
      swipeStart = null;
      const isCommittedSwipe = card
        ? isHorizontalSwipe(dx, dy, WORD_CARD_SWIPE_DISTANCE, WORD_CARD_SWIPE_AXIS_RATIO)
        : isHorizontalSwipe(dx, dy, 80, 1.5, 60);
      if (!isCommittedSwipe) {
        if (card) resetWordCardDrag(true);
        return;
      }
      suppressSwipeClickUntil = Date.now() + 400;
      if (isWordPanelOpen()) {
        const direction = dx < 0 ? 1 : -1;
        const navigated = navigateReaderWord(direction, {
          keepPanelOpen: true,
          animateDirection: direction > 0 ? "next" : "previous",
          persistWord: true
        });
        if (!navigated && card) resetWordCardDrag(true);
        return;
      }
      if (card) resetWordCardDrag(false);
      clearReaderSelection(false);
      changeReaderPage(dx < 0 ? 1 : -1);
    };
    let pdfPinch: PdfPinchState | null = null;
    const isPdfOcrGestureTarget = (target: EventTarget | null): boolean => getPdfOcrViewMode() === "overlay"
      && target instanceof Element
      && Boolean(target.closest(".pdf-ocr-page, .pdf-ocr-stage, .pdf-ocr-toolbar"));
    const shouldReservePdfPan = (target: EventTarget | null): boolean => isPdfOcrGestureTarget(target) && getPdfOcrZoom() > 1.01;
    const touchDistance = (first: Touch, second: Touch): number => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    const touchMidpoint = (first: Touch, second: Touch): SwipePoint => ({
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2
    });
    const beginPdfPinch = (event: TouchEvent): boolean => {
      if (event.touches.length < 2 || !isPdfOcrGestureTarget(event.target)) return false;
      const [first, second] = event.touches;
      pdfPinch = {
        distance: Math.max(1, touchDistance(first, second)),
        zoom: getPdfOcrZoom()
      };
      swipeStart = null;
      return true;
    };
    const updatePdfPinch = (event: TouchEvent): boolean => {
      if (!pdfPinch || event.touches.length < 2) return false;
      const [first, second] = event.touches;
      const midpoint = touchMidpoint(first, second);
      const nextZoom = pdfPinch.zoom * (touchDistance(first, second) / pdfPinch.distance);
      setPdfOcrZoom(nextZoom, { focalClientX: midpoint.x, focalClientY: midpoint.y, commit: false });
      return true;
    };
    readerText.addEventListener("touchstart", (event) => {
      if (beginPdfPinch(event)) {
        event.preventDefault();
        return;
      }
      if (event.touches.length !== 1) {
        swipeStart = null;
        return;
      }
      const touch = event.touches[0];
      if (touch && !shouldReservePdfPan(event.target)) {
        beginSwipe(touch.clientX, touch.clientY, event.target, false, touch.identifier);
      }
    }, { passive: false });
    readerText.addEventListener("touchmove", (event) => {
      if (!updatePdfPinch(event)) return;
      event.preventDefault();
    }, { passive: false });
    readerText.addEventListener("touchend", (event) => {
      if (pdfPinch) {
        if (event.touches.length >= 2) return;
        pdfPinch = null;
        swipeStart = null;
        return;
      }
      const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === swipeStart?.touchId);
      if (touch) finishSwipe(touch.clientX, touch.clientY);
    }, { passive: true });
    readerText.addEventListener("touchcancel", () => {
      swipeStart = null;
      pdfPinch = null;
    }, { passive: true });
    readerText.addEventListener("wheel", (event) => {
      if ((!event.ctrlKey && !event.metaKey) || !isPdfOcrGestureTarget(event.target)) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      adjustPdfOcrZoom(direction * pdfOcrZoomStep(), { focalClientX: event.clientX, focalClientY: event.clientY });
    }, { passive: false });
    readerText.addEventListener("change", (event) => {
      if (!(event.target instanceof Element)) return;
      const pageInput = event.target.closest("#page-jump-input");
      if (!(pageInput instanceof HTMLInputElement)) return;
      event.preventDefault();
      event.stopPropagation();
      goToReaderPage(Number(pageInput.value));
    });
    readerText.addEventListener("click", async (event) => {
      if (Date.now() < suppressSwipeClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!(event.target instanceof Element)) return;
      const zoomBtn = event.target.closest("[data-pdf-zoom]");
      if (zoomBtn instanceof HTMLElement) {
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
      if (pdfViewModeBtn instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        clearReaderSelection(false);
        setPdfOcrViewMode(pdfViewModeBtn.dataset.pdfViewMode);
        renderReader();
        return;
      }
      const pdfCorrectBtn = event.target.closest("[data-pdf-correct]");
      if (pdfCorrectBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();
        if (pdfCorrectBtn.disabled) return;
        pdfCorrectBtn.disabled = true;
        try {
          if (await openCurrentPdfCorrection()) {
            clearReaderSelection(false);
            renderReader();
            requestAnimationFrame(() => {
              const nextButton = readerText.querySelector("[data-pdf-correct]");
              if (nextButton instanceof HTMLElement) nextButton.focus();
            });
          }
        } finally {
          if (pdfCorrectBtn.isConnected) pdfCorrectBtn.disabled = false;
        }
        return;
      }
      const pdfSentenceBtn = event.target.closest("[data-pdf-correct-sentence]");
      if (pdfSentenceBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();
        const wordIndex = Number(pdfSentenceBtn.dataset.pdfPageWordIndex);
        if (pdfSentenceBtn.disabled || !Number.isInteger(wordIndex)) return;
        pdfSentenceBtn.disabled = true;
        try {
          if (await openCurrentPdfCorrection(wordIndex)) {
            clearReaderSelection(false);
            renderReader();
            requestAnimationFrame(() => {
              const nextButton = readerText.querySelector("[data-pdf-correct-sentence]");
              if (nextButton instanceof HTMLElement) nextButton.focus();
            });
          }
        } finally {
          if (pdfSentenceBtn.isConnected) pdfSentenceBtn.disabled = false;
        }
        return;
      }
      const prevBtn = event.target.closest("#btn-prev-page");
      if (prevBtn instanceof HTMLButtonElement && !prevBtn.disabled) {
        event.preventDefault();
        event.stopPropagation();
        changeReaderPage(-1);
        return;
      }
      const nextBtn = event.target.closest("#btn-next-page");
      if (nextBtn instanceof HTMLButtonElement && !nextBtn.disabled) {
        event.preventDefault();
        event.stopPropagation();
        changeReaderPage(1);
        return;
      }
      const token = event.target.closest(".word-token");
      if (token instanceof HTMLElement) {
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
    readerText.addEventListener("dblclick", async (event) => {
      if (!(event.target instanceof Element)) return;
      const token = event.target.closest(".pdf-ocr-word[data-pdf-page-word-index]");
      if (!(token instanceof HTMLElement)) return;
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
    readerText.addEventListener("focusout", () => {
      setTimeout(() => {
        if (document.documentElement.classList.contains("pocket-mode")) return;
        if (Date.now() - lastWordPanelInteractionAt < 700) return;
        const active = document.activeElement;
        if (!active) return;
        if (active.closest?.("#reader-text .word-token, #word-panel")) return;
        clearReaderSelection(true);
      }, 150);
    });
    readerText.addEventListener("keydown", async (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "Enter" && event.key !== " " && event.code !== "Space") return;
      if (!(event.target instanceof Element)) return;
      const token = event.target.closest(".word-token");
      if (!(token instanceof HTMLElement)) return;

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
      if (!wordToSelect) return;

      if (event.ctrlKey && state.selectedWord && state.selectedWord !== wordToSelect) {
          wordToSelect = state.selectedWord + " " + wordToSelect;
      } else {
          setReaderSelectionAnchorFromToken(token);
      }

      const wordIndex = event.ctrlKey ? state.selectedWordIndex : Number(token.dataset.wordIndex);
      selectWord(wordToSelect, normalizeWord, false, wordIndex);
    });

    // Handle smart suggestion click
    wordPanel.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        swipeStart = null;
        resetWordCardDrag(false);
        return;
      }
      const touch = event.touches[0];
      if (touch) beginSwipe(touch.clientX, touch.clientY, event.target, true, touch.identifier);
    }, { passive: true });
    wordPanel.addEventListener("touchmove", (event) => {
      if (event.touches.length !== 1) {
        swipeStart = null;
        resetWordCardDrag(false);
        return;
      }
      const touch = Array.from(event.touches).find((candidate) => candidate.identifier === swipeStart?.touchId);
      if (touch) updateSwipe(touch.clientX, touch.clientY, event);
    }, { passive: false });
    wordPanel.addEventListener("touchend", (event) => {
      const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === swipeStart?.touchId);
      if (touch) finishSwipe(touch.clientX, touch.clientY);
    }, { passive: true });
    wordPanel.addEventListener("touchcancel", () => {
      swipeStart = null;
      resetWordCardDrag(true);
    }, { passive: true });
    wordPanel.addEventListener("pointerdown", rememberWordPanelInteraction);
    wordPanel.addEventListener("touchstart", rememberWordPanelInteraction, { passive: true });
    wordPanel.addEventListener("focusin", rememberWordPanelInteraction);
    wordPanel.addEventListener("click", (event) => {
      if (Date.now() >= suppressSwipeClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });
    wordPanel.addEventListener("click", async (event) => {
      rememberWordPanelInteraction();
      if (Date.now() < suppressSwipeClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!(event.target instanceof Element)) return;
      const articleBtn = event.target.closest("[data-suggest-article]");
      if (articleBtn instanceof HTMLElement && articleBtn.dataset.suggestArticle && articleBtn.dataset.suggestWord) {
        const { updateWordField } = await import("../vocab-actions.js");
        updateWordField(articleBtn.dataset.suggestWord, "article", articleBtn.dataset.suggestArticle);
        const [{ getTextById }, { renderWordPanel }] = await Promise.all([
          import("../reader/renderer.js"),
          import("../reader/word-panel.js")
        ]);
        const targetToken = readerText.querySelector<HTMLElement>(
          `.word-token[data-word="${CSS.escape(articleBtn.dataset.suggestWord)}"]`
        );
        if (state.selectedWord !== articleBtn.dataset.suggestWord && targetToken) {
          await selectReaderToken(targetToken, { openPanel: true });
          return;
        }
        const current = getTextById(state.currentTextId);
        if (current) renderWordPanel(current);
        return;
      }
      const suggestBtn = event.target.closest("[data-suggest-word]");
      if (suggestBtn instanceof HTMLElement && suggestBtn.dataset.suggestWord) {
        const { selectWord } = await import("../vocab-actions.js");
        const { normalizeWord } = await import("../tokenizer_v2.js");
        selectWord(suggestBtn.dataset.suggestWord, normalizeWord, true, state.selectedWordIndex);
      }
    });
  });
}
