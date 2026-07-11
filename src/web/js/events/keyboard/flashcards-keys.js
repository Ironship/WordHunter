import { openYouGlish } from "../../youglish.js";
import { openDictionary } from "../shared.js";

export function handleFlashcardKeys(event, key) {
  const plainKey = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  const exactCtrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (plainKey && (key === "arrowleft" || key === "arrowright")) {
    event.preventDefault();
    const button = document.getElementById(key === "arrowleft" ? "btn-flashcard-prev" : "btn-flashcard-next");
    if (button && !button.disabled) button.click();
    return true;
  }
  if (key === "enter" && plainKey) {
    event.preventDefault();
    document.querySelector('[data-review-action="toggle"]')?.click();
    return true;
  }
  if ((key === " " || key === "spacebar") && (plainKey || exactCtrl)) {
    event.preventDefault();
    const selector = event.ctrlKey
      ? ".review-context [data-tts-word], .review-context-unmasked [data-tts-word]"
      : ".review-word [data-tts-word]";
    const button = document.querySelector(selector);
    if (button) {
      import("../../tts.js").then((tts) => event.ctrlKey
        ? tts.speakText(button.dataset.ttsWord)
        : tts.speakWord(button.dataset.ttsWord));
    }
    return true;
  }
  if (key === "m" && plainKey) {
    event.preventDefault();
    const button = document.querySelector("#review-card [data-dict-word]");
    if (button) openDictionary(button.dataset.dictWord);
    return true;
  }
  if (key === "y" && plainKey) {
    event.preventDefault();
    const button = document.querySelector("#review-card [data-youglish-word]");
    if (button) openYouGlish(button.dataset.youglishWord);
    return true;
  }
  if (key === "i" && plainKey) {
    event.preventDefault();
    const button = document.querySelector('#review-card [data-review-action="search-image"]');
    button?.click();
    return true;
  }

  const grade = plainKey && (/^[0-5]$/.test(key) ? key : event.code?.match(/(?:Digit|Numpad)([0-5])/)?.[1]);
  const button = grade && document.querySelector(`[data-sm2-grade="${grade}"]`);
  if (button) {
    event.preventDefault();
    button.click();
    return true;
  }
  return false;
}
