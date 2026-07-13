import { state, saveUiState } from "../state.js";
import { speakWord } from "../tts.js";
import { setReaderSelectionAnchorFromToken, updateReaderSelection } from "./selection.js";

export function readerTokens() {
  return Array.from(document.getElementById("reader-text")?.querySelectorAll(".word-token") || []);
}

export function findCurrentReaderToken(tokens = readerTokens()) {
  let active = document.activeElement;
  if (!tokens.includes(active)) active = window.lastActiveToken;
  if (!tokens.includes(active) && Number.isInteger(state.selectedWordIndex)) {
    active = tokens.find((token) => Number(token.dataset.wordIndex) === state.selectedWordIndex);
  }
  if (!tokens.includes(active) && state.selectedWord) {
    active = tokens.find((token) => token.dataset.word === state.selectedWord);
  }
  return tokens.includes(active) ? active : null;
}

export function selectReaderToken(token, anchor = true) {
  if (!token) return false;
  document.documentElement.classList.remove("pocket-word-panel-open");
  token.focus();
  window.lastActiveToken = token;
  if (anchor) setReaderSelectionAnchorFromToken(token);
  state.selectedWord = token.dataset.word;
  const wordIndex = Number(token.dataset.wordIndex);
  state.selectedWordIndex = Number.isInteger(wordIndex) && wordIndex >= 0 ? wordIndex : null;
  saveUiState();
  updateReaderSelection({ renderPanel: false });
  speakWord(state.selectedWord);
  return true;
}

export function navigateReaderWord(direction) {
  const tokens = readerTokens();
  if (!tokens.length) return false;
  const step = direction < 0 ? -1 : 1;
  const active = findCurrentReaderToken(tokens);
  const currentIndex = tokens.indexOf(active);
  const nextIndex = currentIndex === -1 ? (step > 0 ? 0 : tokens.length - 1) : currentIndex + step;
  return selectReaderToken(tokens[nextIndex]);
}
