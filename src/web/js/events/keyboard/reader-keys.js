import { state } from "../../state.js";
import { clearReaderSelection, extendReaderSelection } from "../../reader/selection.js";
import { speakWord } from "../../tts.js";
import { setWordStatus } from "../../vocab-actions.js";
import { openDictionary, getSelectedReaderActionText, copySelectedWordToClipboard, hasNativeTextSelection } from "../shared.js";
import { openYouGlish } from "../../youglish.js";
import { navigateReaderWord, readerTokens, selectReaderToken } from "../../reader/word-navigation.js";

function focusSelectedWordField(field) {
  if (!state.selectedWord) return;
  const input = document.querySelector(`[data-word-field="${field}"][data-word="${CSS.escape(state.selectedWord)}"]`);
  if (input) {
    input.focus();
    input.select?.();
  }
}

export function handleReaderKeys(event, key) {
  const plainKey = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  const exactCtrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (key === "escape") {
    const active = document.activeElement;
    if (active?.classList.contains("word-token")) active.blur();
    if (document.activeElement?.tagName === "SELECT") {
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
  if (key === "x" && plainKey && state.selectedWord) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = tokens.indexOf(window.lastActiveToken);
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
      let activeToken = window.lastActiveToken;
      if (!activeToken || !document.body.contains(activeToken)) {
        activeToken = document.activeElement?.classList.contains("word-token") ? document.activeElement : null;
      }
      if (!activeToken && state.selectedWord) {
        try { activeToken = document.getElementById("reader-text")?.querySelector(`.word-token[data-word="${CSS.escape(state.selectedWord)}"]`); } catch (_) { /* ignore invalid selector */ }
      }
      if (!activeToken) return;

      let fullText = "";
      let tokenStart = -1;
      let tokenEnd = -1;
      for (const node of document.getElementById("reader-text")?.childNodes || []) {
        if (node === activeToken) {
          tokenStart = fullText.length;
          fullText += node.textContent;
          tokenEnd = fullText.length;
        } else if (node.nodeType === Node.TEXT_NODE || node.classList?.contains("word-token")) {
          fullText += node.textContent;
        }
      }
      if (tokenStart === -1) return;
      let start = tokenStart;
      while (start > 0 && !/[.!?\n。！？]/.test(fullText[start - 1])) start--;
      let end = tokenEnd;
      while (end < fullText.length && !/[.!?\n。！？]/.test(fullText[end])) end++;
      if (end < fullText.length) end++;
      const sentence = fullText.slice(start, end).trim();
      if (sentence) tts.speakText(sentence, activeToken.parentElement);
    });
    return true;
  }

  if (key === "enter" && exactCtrl) {
    event.preventDefault();
    const tokens = readerTokens();
    const token = tokens[0];
    if (token) selectReaderToken(token);
    return true;
  }

  if ((key === "arrowup" || key === "arrowdown") && exactCtrl && document.activeElement?.classList.contains("word-token")) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = tokens.indexOf(document.activeElement);
    const activeRect = document.activeElement.getBoundingClientRect();
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
    if (plainKey && document.activeElement?.classList.contains("word-token")) {
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
  const showInTextAnswer = document.querySelector("[data-in-text-answer]");
  if (key === "enter" && plainKey && showInTextAnswer) {
    event.preventDefault();
    showInTextAnswer.click();
    return true;
  }
  const reviewDigit = plainKey && (/^[1-5]$/.test(key) ? key : event.code?.match(/(?:Digit|Numpad)([1-5])/)?.[1]);
  const inTextGrade = reviewDigit && document.querySelector(`[data-in-text-grade="${reviewDigit}"]`);
  if (inTextGrade) {
    event.preventDefault();
    inTextGrade.click();
    return true;
  }
  if (key === "5" && plainKey) {
    const suggestion = document.querySelector("#word-panel [data-suggest-word]");
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
  const status = plainKey && (({ 1: "new", 2: "learning", 3: "known", 4: "ignored" })[key] || ({ 1: "new", 2: "learning", 3: "known", 4: "ignored" })[digit]);
  if (status) {
    event.preventDefault();
    setWordStatus(state.selectedWord, status);
    return true;
  }
  if (plainKey && (key === "e" || key === "n")) {
    event.preventDefault();
    focusSelectedWordField(key === "e" ? "translation" : "note");
    return true;
  }
  if (key === "i" && plainKey) {
    event.preventDefault();
    document.querySelector(`[data-action="search-image"][data-word="${CSS.escape(state.selectedWord)}"]`)?.click();
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
    speakWord(getSelectedReaderActionText());
    return true;
  }
  return false;
}
