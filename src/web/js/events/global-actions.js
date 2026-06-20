import { state, saveState } from "../state.js";
import { clearReaderSelectionRange } from "../views/reader.js";
import { gradeReview, loadMoreVocab, removeFromSrs } from "../views/vocabulary.js";
import {
  deleteWord,
  handleReviewAction,
  ignoreWord,
  removeWordImage,
  setWordImage,
  setWordStatus,
  updateWordField
} from "../vocab-actions.js";
import { exportVocabularySelection } from "../sync-actions.js";
import { setReaderFontSize } from "../preferences.js";
import { openYouGlish } from "../youglish.js";
import { speakText, speakWord, stopSpeaking } from "../tts.js";
import { getSelectedReaderActionText, openDictionary } from "./shared.js";
import { renderImageSearch } from "./image-search.js";

function playReaderText(playTextBtn) {
  const readerTextEl = document.getElementById("reader-text");
  let currentText = getReaderTextForTts(readerTextEl);
  if (state.selectedWord && currentText) {
    const wordIndex = currentText.toLowerCase().indexOf(state.selectedWord.toLowerCase());
    if (wordIndex >= 0) currentText = currentText.slice(wordIndex);
  }
  const stopBtn = document.getElementById("tts-stop-text");
  if (playTextBtn && stopBtn) { playTextBtn.hidden = true; stopBtn.hidden = false; }
  speakText(currentText, readerTextEl, () => {
    if (playTextBtn && stopBtn) { playTextBtn.hidden = false; stopBtn.hidden = true; }
  });
}

function getReaderTextForTts(readerTextEl) {
  if (!readerTextEl) return "";
  const ttsText = readerTextEl.dataset.ttsText || "";
  if (ttsText.trim()) return ttsText;
  return readerTextEl.innerText || readerTextEl.textContent || "";
}

function handleReviewButton(reviewButton) {
  if (reviewButton.dataset.reviewAction === "search-image") {
    const word = reviewButton.dataset.word;
    const container = document.getElementById(`review-image-search-results-${word}`);
    if (container) renderImageSearch(container, word);
  } else {
    handleReviewAction(reviewButton.dataset.reviewAction);
  }
}

function handleUploadImageInput(uploadFileInput) {
  if (!uploadFileInput.files?.[0]) return;
  const word = uploadFileInput.dataset.uploadImage;
  const file = uploadFileInput.files[0];
  const reader = new FileReader();
  reader.onload = (e) => { setWordImage(word, e.target.result); };
  reader.readAsDataURL(file);
  uploadFileInput.value = "";
}

function handleGlobalClick(event) {
  const ttsWordBtn = event.target.closest("[data-tts-word]");
  if (ttsWordBtn) speakWord(getSelectedReaderActionText() || ttsWordBtn.dataset.ttsWord);

  const youglishBtn = event.target.closest("[data-youglish-word]");
  if (youglishBtn) openYouGlish(getSelectedReaderActionText() || youglishBtn.dataset.youglishWord);

  const dictBtn = event.target.closest("[data-dict-word]");
  if (dictBtn) openDictionary(getSelectedReaderActionText() || dictBtn.dataset.dictWord);

  if (state.currentView === "reader" && !event.target.closest("#reader-text, #word-panel")) {
    clearReaderSelectionRange(true);
  }

  const playTextBtn = event.target.closest("#tts-play-text");
  if (playTextBtn) playReaderText(playTextBtn);

  const stopTextBtn = event.target.closest("#tts-stop-text");
  if (stopTextBtn) stopSpeaking();

  const readerVocabListBtn = event.target.closest("#reader-vocab-list");
  if (readerVocabListBtn && state.currentTextId) {
    state.filters.vocabTextId = state.currentTextId;
    saveState();
    import("../render.js").then(m => m.setView("vocabulary"));
  }

  const exportVocabTxtBtn = event.target.closest("#export-vocab-txt");
  if (exportVocabTxtBtn) exportVocabularySelection("txt");

  const exportVocabAnkiBtn = event.target.closest("#export-vocab-anki");
  if (exportVocabAnkiBtn) exportVocabularySelection("anki");

  const statusButton = event.target.closest("[data-set-status]");
  if (statusButton) setWordStatus(statusButton.dataset.word, statusButton.dataset.setStatus);

  const deleteButton = event.target.closest("[data-delete-word]");
  if (deleteButton) deleteWord(deleteButton.dataset.deleteWord);

  const ignoreButton = event.target.closest("[data-ignore-word]");
  if (ignoreButton) ignoreWord(ignoreButton.dataset.ignoreWord);

  const reviewButton = event.target.closest("[data-review-action]");
  if (reviewButton) handleReviewButton(reviewButton);

  const uploadImageBtn = event.target.closest("[data-action='upload-image']");
  if (uploadImageBtn) {
    const fileInput = uploadImageBtn.querySelector('input[type="file"]');
    if (fileInput) fileInput.click();
  }

  const uploadFileInput = event.target.closest("[data-upload-image]");
  if (uploadFileInput) handleUploadImageInput(uploadFileInput);

  const searchImageBtn = event.target.closest("[data-action='search-image']");
  if (searchImageBtn) {
    const word = searchImageBtn.dataset.word;
    const container = document.getElementById(`image-search-results-${word}`);
    if (container) renderImageSearch(container, word);
  }

  const saveImageBtn = event.target.closest("[data-action='save-image']");
  if (saveImageBtn) setWordImage(saveImageBtn.dataset.word, saveImageBtn.dataset.imgUrl);

  const removeImageBtn = event.target.closest("[data-action='remove-image']");
  if (removeImageBtn) removeWordImage(removeImageBtn.dataset.word);

  const sm2Button = event.target.closest("[data-sm2-grade]");
  if (sm2Button) gradeReview(sm2Button.dataset.word, Number(sm2Button.dataset.sm2Grade));

  const srsRemove = event.target.closest("[data-srs-remove]");
  if (srsRemove) removeFromSrs(srsRemove.dataset.srsRemove);

  const fontButton = event.target.closest("[data-font]");
  if (fontButton) {
    const delta = fontButton.dataset.font === "up" ? 1 : -1;
    setReaderFontSize((state.readerFontSize || 18) + delta);
    import("../preferences.js").then(m => m.syncSettingsControls());
  }

  const loadMoreVocabBtn = event.target.closest("#load-more-vocab");
  if (loadMoreVocabBtn) loadMoreVocab();
}

let _wordFieldSaveTimer = null;
let _pendingWordField = null;

function scheduleWordFieldSave(word, field, value) {
  _pendingWordField = { word, field, value };
  clearTimeout(_wordFieldSaveTimer);
  _wordFieldSaveTimer = setTimeout(() => {
    _wordFieldSaveTimer = null;
    flushWordFieldSave();
  }, 300);
}

function flushWordFieldSave() {
  if (_pendingWordField) {
    const { word, field, value } = _pendingWordField;
    _pendingWordField = null;
    updateWordField(word, field, value);
  }
}
window.flushWordFieldSave = flushWordFieldSave;

function handleWordFieldInput(event) {
  const field = event.target.closest("[data-word-field]");
  if (!field) return;
  if (field.classList.contains("vocab-translation-input")) {
    field.classList.toggle("empty", !field.value.trim());
  }
  scheduleWordFieldSave(field.dataset.word, field.dataset.wordField, field.value);
}

function handleWordFieldBlur(event) {
  const field = event.target.closest?.("[data-word-field]");
  if (!field) return;
  flushWordFieldSave();
}

export function bindGlobalActionEvents() {
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("input", handleWordFieldInput);
  document.addEventListener("focusout", handleWordFieldBlur);
}
