import { openYouGlish } from "../../youglish.js";
import { openDictionary } from "../shared.js";

export function handleFlashcardKeys(event, key) {
  if (key === "arrowleft" || key === "arrowright") {
    event.preventDefault();
    const button = document.getElementById(key === "arrowleft" ? "btn-flashcard-prev" : "btn-flashcard-next");
    if (button && !button.disabled) button.click();
    return true;
  }
  if (key === "enter") {
    event.preventDefault();
    document.querySelector('[data-review-action="toggle"]')?.click();
    return true;
  }
  if (key === " " || key === "spacebar") {
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
  if (key === "m") {
    event.preventDefault();
    const button = document.querySelector("#review-card [data-dict-word]");
    if (button) openDictionary(button.dataset.dictWord);
    return true;
  }
  if (key === "y") {
    event.preventDefault();
    const button = document.querySelector("#review-card [data-youglish-word]");
    if (button) openYouGlish(button.dataset.youglishWord);
    return true;
  }
  if (key === "i") {
    event.preventDefault();
    document.querySelector('#review-card [data-review-action="search-image"]')?.click();
    return true;
  }

  const grade = /^[0-5]$/.test(key) ? key : event.code?.match(/(?:Digit|Numpad)([0-5])/)?.[1];
  const button = grade && document.querySelector(`[data-sm2-grade="${grade}"]`);
  if (button) {
    event.preventDefault();
    button.click();
    return true;
  }
  return false;
}
