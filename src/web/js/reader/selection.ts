/**
 * Reader text selection: word tokens, ranges, and visual highlighting.
 */
import { state, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { resolveVocabularyKey } from "../tokenizer_v2.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
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

// Between the words of a headword only elision apostrophes and hyphens stay
// ("L'homme", "dit-il"); other punctuation ("Bonjour», dit") becomes a space.
function headwordGap(gap: string): string {
  return /^['’ʼ\-‐]+$/.test(gap) ? gap : " ";
}

function getRangeText(tokens: HTMLButtonElement[], range: WhRecord | null, headword = false): string {
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

    // Gaps inside bold/italic text are rendered as fmt-* spans; they hold the
    // spaces between the words of the phrase.
    const isToken = node instanceof HTMLElement && node.classList.contains("word-token");
    if (isToken || node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement
      && (node.classList.contains("fmt-bold") || node.classList.contains("fmt-italic")))) {
      const content = node.textContent || "";
      text += headword && !isToken ? headwordGap(content) : content;
    }

    if (node === endToken) break;
  }

  return text.replace(/\s+/g, " ").trim();
}

/** The vocabulary key a selected phrase is saved under (the same key a
 *  status or translation change resolves to, e.g. "homme est" for
 *  "L'homme est" in French). */
function phraseKey(text: string): string {
  if (!text) return "";
  const language = effectiveLearningLanguage(state.preferences);
  const memo = lastPhraseKey;
  if (memo && memo.text === text && memo.vocab === state.vocab && memo.language === language) return memo.key;
  // An unsaved phrase makes resolveVocabularyKey scan every vocabulary key,
  // and selection updates ask for the same phrase several times. New
  // entries are saved under the canonical key it returns, so the answer only
  // changes with the vocabulary object (replaced on import and profile
  // switch) or the language.
  const key = resolveVocabularyKey(text, state.vocab, language);
  lastPhraseKey = { text, vocab: state.vocab, language, key };
  return key;
}

let lastPhraseKey: { text: string; vocab: unknown; language: string; key: string } | null = null;

export function getReaderSelectionText(): string {
  const tokens = getReaderWordTokens();
  const text = getRangeText(tokens, state.readerSelectionRange);
  return text && phraseKey(text) === state.selectedWord ? text : "";
}

/** The selected phrase as a headword: its words as written, without the
 *  punctuation between them ("Bonjour dit-il" for «Bonjour», dit-il). */
export function getReaderSelectionHeadword(): string {
  const tokens = getReaderWordTokens();
  const text = getRangeText(tokens, state.readerSelectionRange, true);
  return text && phraseKey(text) === state.selectedWord ? text : "";
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
    state.selectedWord = phraseKey(getRangeText(tokens, range));
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

  state.selectedWord = phraseKey(text);
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
  const rangeText = rangeBounds ? phraseKey(getRangeText(tokens, state.readerSelectionRange)) : "";
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
