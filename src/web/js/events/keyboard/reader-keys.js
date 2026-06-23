import { state } from "../../state.js";
import { renderReader, clearReaderSelectionRange, setReaderSelectionAnchorFromToken, extendReaderSelection } from "../../views/reader.js";
import { speakWord } from "../../tts.js";
import { setWordStatus } from "../../vocab-actions.js";
import { openDictionary, getSelectedReaderActionText, copySelectedWordToClipboard, hasNativeTextSelection } from "../shared.js";
import { openYouGlish } from "../../youglish.js";

function readerTokens() {
  return Array.from(document.getElementById("reader-text")?.querySelectorAll(".word-token") || []);
}

function selectToken(token, anchor = true) {
  token.focus();
  window.lastActiveToken = token;
  if (anchor) setReaderSelectionAnchorFromToken(token);
  import("../../vocab-actions.js").then((actions) => {
    import("../../tokenizer_v2.js").then((tokenizer) => actions.selectWord(token.dataset.word, tokenizer.normalizeWord));
  });
}

function focusSelectedWordField(field) {
  if (!state.selectedWord) return;
  const input = document.querySelector(`[data-word-field="${field}"][data-word="${CSS.escape(state.selectedWord)}"]`);
  if (input) {
    input.focus();
    input.select?.();
  }
}

export function handleReaderKeys(event, key) {
  if (key === "escape") {
    const active = document.activeElement;
    if (active?.classList.contains("word-token")) active.blur();
    if (document.activeElement?.tagName === "SELECT") {
      event.preventDefault();
      document.activeElement.blur();
      return true;
    }
    if (state.readerSelectionRange) clearReaderSelectionRange(false);
    if (state.selectedWord) {
      event.preventDefault();
      state.selectedWord = null;
      renderReader();
      return true;
    }
  }

  const isSpace = key === " " || key === "spacebar" || event.code === "Space";
  if (key === "x" && state.selectedWord) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = tokens.indexOf(window.lastActiveToken);
    import("../../vocab-actions.js").then((actions) => {
      actions.deleteWord(state.selectedWord);
      if (index !== -1 && index + 1 < tokens.length) selectToken(tokens[index + 1], false);
    });
    return true;
  }

  if (isSpace && event.ctrlKey) {
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

  if (key === "enter" && event.ctrlKey) {
    event.preventDefault();
    const tokens = readerTokens();
    const token = state.selectedWord ? tokens.find((item) => item.dataset.word === state.selectedWord) : tokens[0];
    if (token) selectToken(token);
    return true;
  }

  if ((key === "arrowup" || key === "arrowdown") && event.ctrlKey && document.activeElement?.classList.contains("word-token")) {
    event.preventDefault();
    const tokens = readerTokens();
    const index = tokens.indexOf(document.activeElement);
    const activeRect = document.activeElement.getBoundingClientRect();
    const direction = key === "arrowdown" ? 1 : -1;
    for (let next = index + direction; next >= 0 && next < tokens.length; next += direction) {
      const rect = tokens[next].getBoundingClientRect();
      if (direction > 0 ? rect.top >= activeRect.bottom - 4 : rect.bottom <= activeRect.top + 4) {
        selectToken(tokens[next]);
        break;
      }
    }
    return true;
  }

  if (key === "arrowleft" || key === "arrowright") {
    if (event.shiftKey) {
      event.preventDefault();
      extendReaderSelection(key === "arrowleft" ? "left" : "right");
      return true;
    }
    if (document.activeElement?.classList.contains("word-token")) {
      event.preventDefault();
      const tokens = readerTokens();
      const next = tokens.indexOf(document.activeElement) + (key === "arrowleft" ? -1 : 1);
      if (tokens[next]) selectToken(tokens[next]);
      return true;
    }
  }

  if (!state.selectedWord) return false;
  const showInTextAnswer = document.querySelector("[data-in-text-answer]");
  if (key === "enter" && showInTextAnswer) {
    event.preventDefault();
    showInTextAnswer.click();
    return true;
  }
  const reviewDigit = /^[1-5]$/.test(key) ? key : event.code?.match(/(?:Digit|Numpad)([1-5])/)?.[1];
  const inTextGrade = reviewDigit && document.querySelector(`[data-in-text-grade="${reviewDigit}"]`);
  if (inTextGrade) {
    event.preventDefault();
    inTextGrade.click();
    return true;
  }
  if (key === "c" && event.ctrlKey) {
    if (hasNativeTextSelection()) return true;
    event.preventDefault();
    copySelectedWordToClipboard();
    return true;
  }

  const digit = event.code?.match(/Digit([1-4])|Numpad([1-4])/)?.slice(1).find(Boolean);
  const status = ({ 1: "new", 2: "learning", 3: "known", 4: "ignored" })[key] || ({ 1: "new", 2: "learning", 3: "known", 4: "ignored" })[digit];
  if (status) {
    event.preventDefault();
    setWordStatus(state.selectedWord, status);
    return true;
  }
  if (key === "e" || key === "n") {
    event.preventDefault();
    focusSelectedWordField(key === "e" ? "translation" : "note");
    return true;
  }
  if (key === "i") {
    event.preventDefault();
    document.querySelector(`[data-action="search-image"][data-word="${CSS.escape(state.selectedWord)}"]`)?.click();
    return true;
  }
  if (key === "m" || key === "y") {
    event.preventDefault();
    const text = getSelectedReaderActionText();
    if (key === "m") openDictionary(text); else openYouGlish(text);
    return true;
  }
  if (isSpace && !event.ctrlKey) {
    event.preventDefault();
    speakWord(getSelectedReaderActionText());
    return true;
  }
  return false;
}
