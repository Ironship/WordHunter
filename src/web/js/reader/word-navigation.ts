import { state, saveUiState } from "../state.js";
import { normalizeWord } from "../tokenizer_v2.js";
import { speakWord } from "../tts.js";
import { selectWord } from "../vocab-actions.js";
import { setReaderSelectionAnchorFromToken, updateReaderSelection } from "./selection.js";

export type ReaderToken = HTMLButtonElement;

export interface ReaderNavigationOptions {
  keepPanelOpen?: boolean;
  animateDirection?: "next" | "previous";
  persistWord?: boolean;
}

let wordPanelTransitionId = 0;

export function readerTokens(): ReaderToken[] {
  return Array.from(document.getElementById("reader-text")?.querySelectorAll<ReaderToken>(".word-token") || []);
}

export function applyPendingReaderPageFocus(readerText = document.getElementById("reader-text")): boolean {
  if (!readerText || readerText.dataset.focusAfterPageChange !== "1") return false;
  delete readerText.dataset.focusAfterPageChange;
  const firstToken = readerText.querySelector<ReaderToken>(".word-token");
  if (!firstToken) return false;
  firstToken.focus({ preventScroll: true });
  window.lastActiveToken = firstToken;
  return true;
}

export function applyPendingReaderWordFocus(readerText = document.getElementById("reader-text")): boolean {
  if (!readerText) return false;
  const requestedIndex = readerText.dataset.focusWordIndex;
  const requestedWord = readerText.dataset.focusWord;
  if (requestedIndex === undefined && !requestedWord) return false;
  delete readerText.dataset.focusWordIndex;
  delete readerText.dataset.focusWord;
  const exactToken = requestedIndex !== undefined
    ? readerText.querySelector<ReaderToken>(`.word-token[data-word-index="${requestedIndex}"]`)
    : null;
  const token = exactToken || (requestedWord
    ? readerText.querySelector<ReaderToken>(`.word-token[data-word="${CSS.escape(requestedWord)}"]`)
    : null);
  if (!token) return false;
  token.focus({ preventScroll: true });
  window.lastActiveToken = token;
  return true;
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

function clearWordCardDrag(panel: HTMLElement): void {
  panel.classList.remove(
    "word-panel-card-dragging",
    "word-panel-card-drag-left",
    "word-panel-card-drag-right",
    "word-panel-card-snapback"
  );
  panel.style.removeProperty("--word-card-drag-x");
  panel.style.removeProperty("--word-card-drag-rotate");
}

function cancelWordPanelTransition(panel: HTMLElement): void {
  wordPanelTransitionId += 1;
  panel.parentElement?.querySelectorAll(".word-panel-card-ghost").forEach((ghost) => ghost.remove());
  panel.classList.remove(
    "word-panel-enter-next",
    "word-panel-enter-previous",
    "word-panel-exit-next",
    "word-panel-exit-previous"
  );
  delete panel.dataset.wordCardTransition;
  clearWordCardDrag(panel);
}

function transitionWordPanel(
  direction: "next" | "previous",
  select: () => void
): boolean {
  const panel = document.getElementById("word-panel");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (!(panel instanceof HTMLElement) || reducedMotion) {
    if (panel instanceof HTMLElement) cancelWordPanelTransition(panel);
    select();
    return true;
  }
  if (panel.dataset.wordCardTransition) return false;
  const host = panel.parentElement;
  if (!host) {
    clearWordCardDrag(panel);
    select();
    return true;
  }

  const transitionId = String(++wordPanelTransitionId);
  const ghost = panel.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.removeAttribute("aria-live");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  ghost.classList.remove(
    "word-panel-card-dragging",
    "word-panel-card-snapback",
    "word-panel-enter-next",
    "word-panel-enter-previous"
  );
  ghost.classList.add("word-panel-card-ghost", `word-panel-exit-${direction}`);
  host.appendChild(ghost);
  ghost.scrollTop = panel.scrollTop;

  panel.dataset.wordCardTransition = transitionId;
  clearWordCardDrag(panel);
  select();
  void panel.offsetWidth;
  panel.classList.add(`word-panel-enter-${direction}`);

  let finished = false;
  let timer = 0;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    panel.removeEventListener("animationend", onEnterEnd);
    ghost.remove();
    if (panel.dataset.wordCardTransition !== transitionId) return;
    panel.classList.remove(`word-panel-enter-${direction}`);
    delete panel.dataset.wordCardTransition;
  };
  const onEnterEnd = (event: AnimationEvent): void => {
    if (event.target === panel) finish();
  };
  panel.addEventListener("animationend", onEnterEnd);
  timer = window.setTimeout(finish, 340);
  return true;
}

export function selectReaderToken(
  token: ReaderToken | null | undefined,
  anchor = true,
  options: ReaderNavigationOptions = {}
): boolean {
  const rawWord = token?.dataset.word;
  if (!token || !rawWord) return false;
  const root = document.documentElement;
  const pocketPanelWasOpen = root.classList.contains("pocket-word-panel-open");
  const wordIndex = Number(token.dataset.wordIndex);
  const select = (): void => {
    if (!options.keepPanelOpen) root.classList.remove("pocket-word-panel-open");
    token.focus();
    window.lastActiveToken = token;
    if (anchor) setReaderSelectionAnchorFromToken(token);
    const selectedWordIndex = Number.isInteger(wordIndex) && wordIndex >= 0 ? wordIndex : null;
    if (options.persistWord) {
      selectWord(rawWord, normalizeWord, false, selectedWordIndex, { forceSpeak: true });
    } else {
      state.selectedWord = rawWord;
      state.selectedWordIndex = selectedWordIndex;
      saveUiState();
      updateReaderSelection({ renderPanel: options.keepPanelOpen === true });
      speakWord(rawWord);
    }
    if (options.keepPanelOpen && pocketPanelWasOpen) root.classList.add("pocket-word-panel-open");
  };

  if (options.animateDirection) return transitionWordPanel(options.animateDirection, select);
  const panel = document.getElementById("word-panel");
  if (panel instanceof HTMLElement) cancelWordPanelTransition(panel);
  select();
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
