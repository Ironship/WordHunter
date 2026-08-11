/**
 * Reader text selection: word tokens, ranges, and visual highlighting.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { normalizeWord } from "../tokenizer_v2.js";
import { getTextById } from "./renderer.js";
import { renderWordPanel } from "./word-panel.js";
import { keepReaderTokenVisible } from "./visibility.js";
import { renderShell } from "../views/shell.js";

interface ReaderRangeBounds {
  start: number;
  end: number;
  anchor: number;
  focus: number;
}

export interface UpdateReaderSelectionOptions {
  renderPanel?: boolean;
  keepVisible?: boolean;
}

let tokenCacheRoot: HTMLElement | null = null;
let tokenCacheRenderId = "";
let tokenCache: HTMLButtonElement[] = [];

export function getReaderWordTokens(): HTMLButtonElement[] {
  const readerText = els.readerText as HTMLElement | null;
  if (!readerText) return [];
  const renderId = readerText.dataset?.renderId || "";
  if (readerText !== tokenCacheRoot || renderId !== tokenCacheRenderId) {
    tokenCacheRoot = readerText;
    tokenCacheRenderId = renderId;
    tokenCache = Array.from(readerText.querySelectorAll<HTMLButtonElement>(".word-token"));
  }
  return tokenCache;
}

function getRangeBounds(range: WhRecord | null): ReaderRangeBounds | null {
  if (!range) return null;
  const anchor = Number(range.anchor);
  const focus = Number(range.focus);
  if (!Number.isInteger(anchor) || !Number.isInteger(focus)) return null;
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    anchor,
    focus
  };
}

function getRangeText(tokens: HTMLButtonElement[], range: WhRecord | null): string {
  const bounds = getRangeBounds(range);
  if (!bounds) return "";
  const startToken = tokens[bounds.start];
  const endToken = tokens[bounds.end];
  if (!startToken || !endToken || !els.readerText) return "";

  const startOcrPage = startToken.closest?.(".pdf-ocr-page, .pdf-text-page");
  const endOcrPage = endToken.closest?.(".pdf-ocr-page, .pdf-text-page");
  if (startOcrPage && startOcrPage === endOcrPage) {
    const pageTokens = Array.from(startOcrPage.querySelectorAll<HTMLButtonElement>(".word-token"));
    const startIndex = pageTokens.indexOf(startToken);
    const endIndex = pageTokens.indexOf(endToken);
    if (startIndex !== -1 && endIndex !== -1) {
      return pageTokens
        .slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
        .map((token) => token.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  let collecting = false;
  let text = "";
  for (const node of els.readerText.childNodes) {
    if (node === startToken) collecting = true;
    if (!collecting) continue;

    if (node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && node.classList.contains("word-token"))) {
      text += node.textContent || "";
    }

    if (node === endToken) break;
  }

  return text.replace(/\s+/g, " ").trim();
}

export function getReaderSelectionText(): string {
  const tokens = getReaderWordTokens();
  const text = getRangeText(tokens, state.readerSelectionRange);
  return normalizeWord(text) === state.selectedWord ? text : "";
}

export function setReaderSelectionAnchorFromToken(token: HTMLElement): boolean {
  const tokens = getReaderWordTokens();
  const index = tokens.findIndex((candidate) => candidate === token);
  if (index === -1) return false;
  state.readerSelectionRange = { anchor: index, focus: index };
  window.lastActiveToken = token;
  return true;
}

export function clearReaderSelectionRange(renderSelection = false): void {
  if (!state.readerSelectionRange) return;
  state.readerSelectionRange = null;
  saveUiState();
  if (renderSelection) updateReaderSelection();
}

export function clearReaderSelection(renderSelection = false): void {
  document.documentElement.classList.remove("pocket-word-panel-open");
  if (!state.selectedWord && !state.readerSelectionRange) return;
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  saveUiState();
  renderShell();
  if (renderSelection) updateReaderSelection();
}

/** Maps a native DOM text selection over the reader text to the token-range
 *  phrase state, so touch (and mouse-drag) phrase selection works. Single-token
 *  selections are ignored — the tap path owns those. */
export function bindTouchPhraseSelection(): void {
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!(anchorNode instanceof Node) || !(focusNode instanceof Node)) return;
    if (!els.readerText?.contains(anchorNode) || !els.readerText?.contains(focusNode)) return;
    const tokenOf = (node: Node): HTMLButtonElement | null => {
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
      const token = element?.closest?.(".word-token");
      return token instanceof HTMLButtonElement ? token : null;
    };
    const anchorToken = tokenOf(anchorNode);
    const focusToken = tokenOf(focusNode);
    if (!anchorToken || !focusToken) return;
    const tokens = getReaderWordTokens();
    const anchorIndex = tokens.indexOf(anchorToken);
    const focusIndex = tokens.indexOf(focusToken);
    if (anchorIndex === -1 || focusIndex === -1 || anchorIndex === focusIndex) return;
    const range: WhRecord = { anchor: anchorIndex, focus: focusIndex };
    const current = state.readerSelectionRange;
    if (current && Number(current.anchor) === anchorIndex && Number(current.focus) === focusIndex) return;
    state.readerSelectionRange = range;
    state.selectedWord = normalizeWord(getRangeText(tokens, range));
    saveUiState();
    window.lastActiveToken = tokens[focusIndex];
    updateReaderSelection();
  });
}

export function extendReaderSelection(direction: "left" | "right"): boolean {
  const tokens = getReaderWordTokens();
  if (!tokens.length) return false;

  const focused = document.activeElement;
  const activeToken = focused instanceof HTMLButtonElement && focused.classList.contains("word-token")
    ? focused
    : (window.lastActiveToken instanceof HTMLButtonElement && document.body.contains(window.lastActiveToken) ? window.lastActiveToken : null);
  const activeIndex = tokens.indexOf(activeToken);
  if (activeIndex === -1) return false;

  let range = state.readerSelectionRange;
  if (!range || Number(range.focus) !== activeIndex) {
    range = { anchor: activeIndex, focus: activeIndex };
  }

  const step = direction === "left" ? -1 : 1;
  const nextFocus = Math.max(0, Math.min(tokens.length - 1, Number(range.focus) + step));
  state.readerSelectionRange = { anchor: Number(range.anchor), focus: nextFocus };
  const text = getRangeText(tokens, state.readerSelectionRange);
  if (!text) return false;

  state.selectedWord = normalizeWord(text);
  saveUiState();
  window.lastActiveToken = tokens[nextFocus];
  tokens[nextFocus].focus({ preventScroll: true });
  updateReaderSelection();
  return true;
}

export function updateReaderSelection(options: UpdateReaderSelectionOptions = {}): void {
  if (!els.readerText) return;
  const current = getTextById(state.currentTextId);
  if (!current) return;

  // Update 'selected' classes without reloading the entire text
  const tokens = getReaderWordTokens();
  const rangeBounds = getRangeBounds(state.readerSelectionRange);
  const rangeText = rangeBounds ? normalizeWord(getRangeText(tokens, state.readerSelectionRange)) : "";
  const useRange = !!rangeBounds && !!rangeText && rangeText === state.selectedWord;
  if (state.readerSelectionRange && !useRange) {
    state.readerSelectionRange = null;
  }
  tokens.forEach((token, index) => {
    if ((useRange && index >= rangeBounds.start && index <= rangeBounds.end) || token.dataset.word === state.selectedWord) {
      token.classList.add("selected");
    } else {
      token.classList.remove("selected");
    }
  });
  const activeToken = useRange
    ? tokens[rangeBounds.focus]
    : tokens.find((token) => Number(token.dataset.wordIndex) === state.selectedWordIndex);
  if (options.keepVisible !== false) keepReaderTokenVisible(activeToken);

  const sentenceButton = (els.readerText as HTMLElement).querySelector<HTMLButtonElement>("[data-pdf-correct-sentence]");
  if (sentenceButton) {
    const selectedOcrWord = tokens.find((token) => token.classList.contains("selected")
      && Number.isInteger(Number(token.dataset.pdfPageWordIndex)));
    sentenceButton.disabled = !selectedOcrWord;
    if (selectedOcrWord) sentenceButton.dataset.pdfPageWordIndex = selectedOcrWord.dataset.pdfPageWordIndex;
    else delete sentenceButton.dataset.pdfPageWordIndex;
  }

  if (options.renderPanel !== false) renderWordPanel(current);
}
