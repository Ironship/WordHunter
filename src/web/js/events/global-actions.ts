import { registerFrontendStateFlusher, state } from "../state.js";
import { clearReaderSelection } from "../reader/selection.js";
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
import { setReaderFontSize, syncSettingsControls, updatePreferenceValue } from "../preferences.js";
import { openYouGlish } from "../youglish.js";
import { speakText, speakWord, stopSpeaking } from "../tts.js";
import { copySelectedWordToClipboard, getSelectedReaderActionText, openDictionary } from "./shared.js";
import { renderImageSearch } from "./image-search.js";

function playReaderText(playTextBtn: HTMLElement): void {
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

function getReaderTextForTts(readerTextEl: HTMLElement | null): string {
  if (!readerTextEl) return "";
  const ttsText = readerTextEl.dataset.ttsText || "";
  if (ttsText.trim()) return ttsText;
  return readerTextEl.innerText || readerTextEl.textContent || "";
}

function handleReviewButton(reviewButton: HTMLElement): void {
  if (reviewButton.dataset.reviewAction === "search-image") {
    const word = reviewButton.dataset.word;
    const container = document.getElementById(`review-image-search-results-${word}`);
    if (container) renderImageSearch(container, word);
  } else {
    handleReviewAction(reviewButton.dataset.reviewAction);
  }
}

function handleUploadImageInput(uploadFileInput: HTMLInputElement): void {
  if (!uploadFileInput.files?.[0]) return;
  const word = uploadFileInput.dataset.uploadImage;
  const file = uploadFileInput.files[0];
  const reader = new FileReader();
  reader.onload = (event: ProgressEvent<FileReader>) => { setWordImage(word, event.target?.result); };
  reader.readAsDataURL(file);
  uploadFileInput.value = "";
}

function eventElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? target as Element : null;
}

function handleGlobalClick(event: MouseEvent): void {
  const target = eventElement(event.target);
  if (!target) return;
  const closeWordPanelBtn = target.closest<HTMLElement>("[data-close-word-panel]");
  if (closeWordPanelBtn) {
    document.documentElement.classList.remove("pocket-word-panel-open");
    clearReaderSelection(true);
    return;
  }

  const ttsWordBtn = target.closest<HTMLElement>("[data-tts-word]");
  if (ttsWordBtn) speakWord(getSelectedReaderActionText() || ttsWordBtn.dataset.ttsWord);

  const youglishBtn = target.closest<HTMLElement>("[data-youglish-word]");
  if (youglishBtn) openYouGlish(getSelectedReaderActionText() || youglishBtn.dataset.youglishWord);

  const dictBtn = target.closest<HTMLElement>("[data-dict-word]");
  if (dictBtn) openDictionary(getSelectedReaderActionText() || dictBtn.dataset.dictWord);

  const copyWordBtn = target.closest<HTMLElement>("[data-copy-word]");
  if (copyWordBtn) copySelectedWordToClipboard();

  const clickPath = event.composedPath?.() || [];
  const clickedReaderSurface = target.closest("#reader-text, #word-panel, #reader-view .reader-toolbar, dialog")
    || clickPath.some((node: EventTarget) => (node as Element)?.id === "reader-text" || (node as Element)?.id === "word-panel");
  if (state.currentView === "reader"
    && !document.documentElement.classList.contains("pocket-mode")
    && !clickedReaderSurface) {
    clearReaderSelection(true);
  }

  const playTextBtn = target.closest<HTMLElement>("#tts-play-text");
  if (playTextBtn) playReaderText(playTextBtn);

  const stopTextBtn = target.closest("#tts-stop-text");
  if (stopTextBtn) stopSpeaking();

  const readerHighlightToggleBtn = target.closest("#reader-highlight-toggle");
  if (readerHighlightToggleBtn) {
    updatePreferenceValue("highlightTokens", state.preferences.highlightTokens === false);
    syncSettingsControls();
  }

  const readerWordPanelToggleBtn = target.closest("#reader-word-panel-toggle");
  if (readerWordPanelToggleBtn) {
    updatePreferenceValue("readerWordPanelVisible", state.preferences.readerWordPanelVisible === false);
    syncSettingsControls();
  }

  const exportVocabTxtBtn = target.closest("#export-vocab-txt");
  if (exportVocabTxtBtn) exportVocabularySelection("txt");

  const exportVocabAnkiBtn = target.closest("#export-vocab-anki");
  if (exportVocabAnkiBtn) exportVocabularySelection("anki");

  const statusButton = target.closest<HTMLElement>("[data-set-status]");
  if (statusButton) setWordStatus(statusButton.dataset.word, statusButton.dataset.setStatus);

  const deleteButton = target.closest<HTMLElement>("[data-delete-word]");
  if (deleteButton) deleteWord(deleteButton.dataset.deleteWord);

  const ignoreButton = target.closest<HTMLElement>("[data-ignore-word]");
  if (ignoreButton) ignoreWord(ignoreButton.dataset.ignoreWord);

  const reviewButton = target.closest<HTMLElement>("[data-review-action]");
  if (reviewButton) handleReviewButton(reviewButton);

  const uploadImageBtn = target.closest<HTMLElement>("[data-action='upload-image']");
  if (uploadImageBtn) {
    const fileInput = uploadImageBtn.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput && target !== fileInput) fileInput.click();
  }

  const searchImageBtn = target.closest<HTMLElement>("[data-action='search-image']");
  if (searchImageBtn) {
    const word = searchImageBtn.dataset.word;
    const container = document.getElementById(`image-search-results-${word}`);
    if (container) renderImageSearch(container, word);
  }

  const saveImageBtn = target.closest<HTMLElement>("[data-action='save-image']");
  if (saveImageBtn) setWordImage(saveImageBtn.dataset.word, saveImageBtn.dataset.imgUrl);

  const removeImageBtn = target.closest<HTMLElement>("[data-action='remove-image']");
  if (removeImageBtn) removeWordImage(removeImageBtn.dataset.word);

  const sm2Button = target.closest<HTMLElement>("[data-sm2-grade]");
  if (sm2Button) gradeReview(sm2Button.dataset.word, Number(sm2Button.dataset.sm2Grade));

  const srsRemove = target.closest<HTMLElement>("[data-srs-remove]");
  if (srsRemove) removeFromSrs(srsRemove.dataset.srsRemove);

  const fontButton = target.closest<HTMLElement>("[data-font]");
  if (fontButton) {
    const delta = fontButton.dataset.font === "up" ? 1 : -1;
    setReaderFontSize((state.readerFontSize || 18) + delta);
    import("../preferences.js").then(m => m.syncSettingsControls());
  }

  const loadMoreVocabBtn = target.closest("#load-more-vocab");
  if (loadMoreVocabBtn) loadMoreVocab();
}

function handleGlobalActionKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  const action = eventElement(event.target)?.closest<HTMLElement>('[role="button"][data-action]');
  if (!action) return;
  event.preventDefault();
  action.click();
}

export function handleGlobalChange(event: Event): void {
  const uploadFileInput = eventElement(event.target)?.closest<HTMLInputElement>("[data-upload-image]");
  if (uploadFileInput) handleUploadImageInput(uploadFileInput);
}

let _wordFieldSaveTimer: number | null = null;
let _pendingWordField: { word: string; field: string; value: string } | null = null;
let wordFieldFlusherRegistered = false;

function scheduleWordFieldSave(word: string, field: string, value: string): void {
  _pendingWordField = { word, field, value };
  clearTimeout(_wordFieldSaveTimer);
  _wordFieldSaveTimer = window.setTimeout(() => {
    _wordFieldSaveTimer = null;
    flushWordFieldSave();
  }, 300);
}

function flushWordFieldSave(): void {
  clearTimeout(_wordFieldSaveTimer);
  _wordFieldSaveTimer = null;
  if (_pendingWordField) {
    const { word, field, value } = _pendingWordField;
    _pendingWordField = null;
    updateWordField(word, field, value);
  }
}
(window as Window & { flushWordFieldSave?: typeof flushWordFieldSave }).flushWordFieldSave = flushWordFieldSave;

function handleWordFieldInput(event: Event): void {
  const field = eventElement(event.target)?.closest<HTMLInputElement | HTMLTextAreaElement>("[data-word-field]");
  if (!field) return;
  if (field.classList.contains("vocab-translation-input")) {
    field.classList.toggle("empty", !field.value.trim());
  }
  scheduleWordFieldSave(field.dataset.word, field.dataset.wordField, field.value);
}

function handleWordFieldBlur(event: FocusEvent): void {
  const field = eventElement(event.target)?.closest<HTMLInputElement | HTMLTextAreaElement>("[data-word-field]");
  if (!field) return;
  flushWordFieldSave();
}

export function bindGlobalActionEvents(): void {
  if (!wordFieldFlusherRegistered) {
    wordFieldFlusherRegistered = true;
    registerFrontendStateFlusher(flushWordFieldSave);
  }
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("change", handleGlobalChange);
  document.addEventListener("input", handleWordFieldInput);
  document.addEventListener("focusout", handleWordFieldBlur);
  document.addEventListener("keydown", handleGlobalActionKeydown);
}
