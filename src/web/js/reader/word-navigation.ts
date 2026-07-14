import { state, saveUiState } from "../state.js";
import { speakWord } from "../tts.js";
import { setReaderSelectionAnchorFromToken, updateReaderSelection } from "./selection.js";

export type ReaderToken = HTMLButtonElement;

export interface ReaderNavigationOptions {
  keepPanelOpen?: boolean;
  animateDirection?: "next" | "previous";
}

export function readerTokens(): ReaderToken[] {
  return Array.from(document.getElementById("reader-text")?.querySelectorAll<ReaderToken>(".word-token") || []);
}

export function findCurrentReaderToken(tokens: ReaderToken[] = readerTokens()): ReaderToken | null {
  let active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  if (!active || !tokens.includes(active)) {
    active = window.lastActiveToken instanceof HTMLButtonElement ? window.lastActiveToken : null;
  }
  if ((!active || !tokens.includes(active)) && Number.isInteger(state.selectedWordIndex)) {
    active = tokens.find((token) => Number(token.dataset.wordIndex) === state.selectedWordIndex);
  }
  if ((!active || !tokens.includes(active)) && state.selectedWord) {
    active = tokens.find((token) => token.dataset.word === state.selectedWord);
  }
  return active && tokens.includes(active) ? active : null;
}

function animateWordPanel(direction: "next" | "previous" | undefined): void {
  if (!direction) return;
  const panel = document.getElementById("word-panel");
  if (!(panel instanceof HTMLElement)) return;
  panel.classList.remove("word-panel-enter-next", "word-panel-enter-previous");
  void panel.offsetWidth;
  panel.classList.add(`word-panel-enter-${direction}`);
}

export function selectReaderToken(
  token: ReaderToken | null | undefined,
  anchor = true,
  options: ReaderNavigationOptions = {}
): boolean {
  if (!token) return false;
  const root = document.documentElement;
  const pocketPanelWasOpen = root.classList.contains("pocket-word-panel-open");
  if (!options.keepPanelOpen) root.classList.remove("pocket-word-panel-open");
  token.focus();
  window.lastActiveToken = token;
  if (anchor) setReaderSelectionAnchorFromToken(token);
  state.selectedWord = token.dataset.word;
  const wordIndex = Number(token.dataset.wordIndex);
  state.selectedWordIndex = Number.isInteger(wordIndex) && wordIndex >= 0 ? wordIndex : null;
  saveUiState();
  updateReaderSelection({ renderPanel: options.keepPanelOpen === true });
  if (options.keepPanelOpen && pocketPanelWasOpen) root.classList.add("pocket-word-panel-open");
  animateWordPanel(options.animateDirection);
  speakWord(state.selectedWord);
  return true;
}

export function navigateReaderWord(direction: number, options: ReaderNavigationOptions = {}): boolean {
  const tokens = readerTokens();
  if (!tokens.length) return false;
  const step = direction < 0 ? -1 : 1;
  const active = findCurrentReaderToken(tokens);
  const currentIndex = tokens.indexOf(active);
  const nextIndex = currentIndex === -1 ? (step > 0 ? 0 : tokens.length - 1) : currentIndex + step;
  return selectReaderToken(tokens[nextIndex], true, options);
}
