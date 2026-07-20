import { state } from "../../state.js";
import { clearReaderSelection, extendReaderSelection } from "../../reader/selection.js";
import { speakWord } from "../../tts.js";
import { setWordStatus } from "../../vocab-actions.js";
import { openDictionary, getSelectedReaderActionText, copySelectedWordToClipboard, hasNativeTextSelection } from "../shared.js";
import { openYouGlish } from "../../youglish.js";
import { findCurrentReaderToken, navigateReaderWord, readerTokens, selectReaderToken } from "../../reader/word-navigation.js";
import { toggleReaderBookmarkAtCurrentWord } from "../../reader/bookmarks.js";
import { isAndroidPlatform } from "../../platform.js";

function focusSelectedWordField(field: "translation" | "note"): boolean {
  if (!state.selectedWord) return false;
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#word-panel [data-word-field="${field}"][data-word="${CSS.escape(state.selectedWord)}"]`);
  if (!input) return false;
  input.focus();
  input.select?.();
  return true;
}

function toggleReaderPaneFocus(): boolean {
  const panel = document.getElementById("word-panel");
  if (!(panel instanceof HTMLElement) || state.preferences.readerWordPanelVisible === false) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active === panel || panel.contains(active))) {
    const tokens = readerTokens();
    const token = findCurrentReaderToken(tokens) || tokens[0];
    if (!token) return false;
    token.focus({ preventScroll: true });
    window.lastActiveToken = token;
    return true;
  }
  panel.focus({ preventScroll: true });
  return true;
}

export function handleReaderKeys(event: KeyboardEvent, key: string): boolean {
  const plainKey = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  const exactCtrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (key === "escape") {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains("word-token")) active.blur();
    if (document.activeElement instanceof HTMLSelectElement) {
      event.preventDefault();
      document.activeElement.blur();
      return true;
    }
    if (state.readerSelectionRange || state.selectedWord) {
      event.preventDefault();
      clearReaderSelection(true);
      return true;
    }
  }

  const isSpace = key === " " || key === "spacebar" || event.code === "Space";
  if (isSpace && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (isAndroidPlatform()) return false;
    const play = document.getElementById("tts-play-text") as HTMLButtonElement | null;
    const stop = document.getElementById("tts-stop-text") as HTMLButtonElement | null;
    const control = stop && !stop.hidden ? stop : play;
    if (!control || control.disabled) return false;
    event.preventDefault();
    control.click();
    return true;
  }

  if (key === "b" && plainKey) {
    if (isAndroidPlatform()) return false;
    const token = findCurrentReaderToken(readerTokens());
    const wordIndex = Number(token?.dataset.wordIndex);
    if (!Number.isInteger(wordIndex) || wordIndex < 0) return false;
    event.preventDefault();
    toggleReaderBookmarkAtCurrentWord(wordIndex);
    return true;
  }

  if (key === "f6" && plainKey) {
    if (isAndroidPlatform()) return false;
    if (!toggleReaderPaneFocus()) return false;
    event.preventDefault();
    return true;
  }

  if (exactCtrl && (key === "home" || key === "end")) {
    if (isAndroidPlatform()) return false;
    const tokens = readerTokens();
    const token = key === "home" ? tokens[0] : tokens[tokens.length - 1];
    if (!token) return false;
    event.preventDefault();
    selectReaderToken(token);
    return true;
  }

  if (key === "x" && plainKey && state.selectedWord) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = window.lastActiveToken instanceof HTMLButtonElement
      ? tokens.indexOf(window.lastActiveToken)
      : -1;
    import("../../vocab-actions.js").then((actions) => {
      actions.deleteWord(state.selectedWord);
      if (index !== -1 && index + 1 < tokens.length) selectReaderToken(tokens[index + 1], false);
    });
    return true;
  }

  if (isSpace && exactCtrl) {
    event.preventDefault();
    import("../../tts.js").then((tts) => {
      if (window.speechSynthesis?.speaking) {
        tts.stopSpeaking();
        return;
      }
      let activeToken = window.lastActiveToken instanceof HTMLButtonElement ? window.lastActiveToken : null;
      if (!activeToken || !document.body.contains(activeToken)) {
        const focused = document.activeElement;
        activeToken = focused instanceof HTMLButtonElement && focused.classList.contains("word-token") ? focused : null;
      }
      if (!activeToken && state.selectedWord) {
        try { activeToken = document.getElementById("reader-text")?.querySelector<HTMLButtonElement>(`.word-token[data-word="${CSS.escape(state.selectedWord)}"]`); } catch (_) { /* ignore invalid selector */ }
      }
      if (!activeToken) return;

      let fullText = "";
      let tokenStart = -1;
      let tokenEnd = -1;
      for (const node of document.getElementById("reader-text")?.childNodes || []) {
        if (node === activeToken) {
          tokenStart = fullText.length;
          fullText += node.textContent || "";
          tokenEnd = fullText.length;
        } else if (node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && node.classList.contains("word-token"))) {
          fullText += node.textContent || "";
        }
      }
      if (tokenStart === -1) return;
      let start = tokenStart;
      while (start > 0 && !/[.!?\n。！？]/.test(fullText[start - 1])) start--;
      let end = tokenEnd;
      while (end < fullText.length && !/[.!?\n。！？]/.test(fullText[end])) end++;
      if (end < fullText.length) end++;
      const sentence = fullText.slice(start, end).trim();
      if (sentence) tts.speakText(sentence, activeToken.parentElement, undefined);
    });
    return true;
  }

  if (key === "enter" && exactCtrl) {
    event.preventDefault();
    const tokens = readerTokens();
    const token = findCurrentReaderToken(tokens);
    if (token) selectReaderToken(token);
    return true;
  }

  const activeToken = document.activeElement;
  if ((key === "arrowup" || key === "arrowdown") && exactCtrl && activeToken instanceof HTMLButtonElement && activeToken.classList.contains("word-token")) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = tokens.indexOf(activeToken);
    const activeRect = activeToken.getBoundingClientRect();
    const direction = key === "arrowdown" ? 1 : -1;
    for (let next = index + direction; next >= 0 && next < tokens.length; next += direction) {
      const rect = tokens[next].getBoundingClientRect();
      if (direction > 0 ? rect.top >= activeRect.bottom - 4 : rect.bottom <= activeRect.top + 4) {
        selectReaderToken(tokens[next]);
        break;
      }
    }
    return true;
  }

  if (key === "arrowleft" || key === "arrowright") {
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      extendReaderSelection(key === "arrowleft" ? "left" : "right");
      return true;
    }
    if (plainKey && activeToken instanceof HTMLButtonElement && activeToken.classList.contains("word-token")) {
      event.preventDefault();
      navigateReaderWord(key === "arrowleft" ? -1 : 1);
      return true;
    }
  }

  if (!state.selectedWord) {
    if (plainKey && (key === "i" || key === "m" || key === "y")) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  const showInTextAnswer = document.querySelector<HTMLButtonElement>("[data-in-text-answer]");
  if (key === "enter" && plainKey && showInTextAnswer) {
    event.preventDefault();
    showInTextAnswer.click();
    return true;
  }
  const reviewDigit = plainKey && (/^[1-5]$/.test(key) ? key : event.code?.match(/(?:Digit|Numpad)([1-5])/)?.[1]);
  const inTextGrade = reviewDigit && document.querySelector<HTMLButtonElement>(`[data-in-text-grade="${reviewDigit}"]`);
  if (inTextGrade) {
    event.preventDefault();
    inTextGrade.click();
    return true;
  }
  if (key === "5" && plainKey) {
    const suggestion = document.querySelector<HTMLButtonElement>("#word-panel [data-suggest-word]");
    if (suggestion) {
      event.preventDefault();
      suggestion.click();
      return true;
    }
  }
  if (key === "c" && exactCtrl) {
    if (hasNativeTextSelection()) return true;
    event.preventDefault();
    copySelectedWordToClipboard();
    return true;
  }

  const digit = plainKey && event.code?.match(/Digit([1-4])|Numpad([1-4])/)?.slice(1).find(Boolean);
  const statuses: Partial<Record<string, WhVocabStatus>> = { 1: "new", 2: "learning", 3: "known", 4: "ignored" };
  const status = plainKey && (statuses[key] || (digit ? statuses[digit] : undefined));
  if (status) {
    event.preventDefault();
    setWordStatus(state.selectedWord, status);
    return true;
  }
  if (plainKey && (key === "e" || key === "n")) {
    if (focusSelectedWordField(key === "e" ? "translation" : "note")) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  if (key === "i" && plainKey) {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>(`[data-action="search-image"][data-word="${CSS.escape(state.selectedWord)}"]`)?.click();
    return true;
  }
  if (plainKey && (key === "m" || key === "y")) {
    event.preventDefault();
    const text = getSelectedReaderActionText();
    if (key === "m") openDictionary(text); else openYouGlish(text);
    return true;
  }
  if (isSpace && plainKey) {
    event.preventDefault();
    speakWord(getSelectedReaderActionText(true));
    return true;
  }
  return false;
}
