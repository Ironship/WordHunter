import { state, saveState, initialVocabKeys } from "./state.js";
import { STATUS_ORDER } from "./constants.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, updateReaderSelection } from "./render.js";
import { getTextById, updateWordStatusInReader } from "./views/reader.js";
import { renderShell } from "./views/shell.js";
import { getOrCreateEntry, renderVocabulary, renderReview, hideReviewAnswer, toggleReviewAnswer } from "./views/vocabulary.js";
import { renderLibrary } from "./views/library.js";
import { speakWord } from "./tts.js";

let lastAutoTtsFocusKey = "";

async function maybeAutoTranslateWord(word, entry) {
  if (state.preferences?.offlineTranslator !== true) return false;
  if (state.preferences?.autoTranslateWords !== true) return false;
  if (!entry || String(entry.translation || "").trim()) return false;
  if (entry.translationAutoRejected === true) return false;
  
  try {
    const fromLang = state.preferences.learningLanguage || "en";
    const toLang = state.preferences.locale || "pl";
    const url = `/__argos/translate?text=${encodeURIComponent(word)}&from=${encodeURIComponent(fromLang)}&to=${encodeURIComponent(toLang)}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.translated && data.translated !== word) {
        entry.translation = data.translated.toLowerCase();
        entry.translationSource = "argos";
        entry.updatedAt = new Date().toISOString();
        saveState();
        
        if (state.currentView === "reader") updateReaderSelection();
        else if (state.currentView === "vocabulary") renderVocabulary();
        else if (state.currentView === "flashcards") renderReview();
        
        return true;
      }
    }
  } catch (e) {
    console.warn("Argos translation failed", e);
  }

  return false;
}

export function selectWord(rawWord, normalizeFn, preserveScroll = false) {
  const word = normalizeFn(rawWord);
  if (!word) return;
  const current = getTextById(state.currentTextId);
  const isFresh = !Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word, current?.text || "");
  maybeAutoTranslateWord(word, entry);
  let statusChanged = false;
  if (isFresh && state.preferences?.autoLearnOnClick) {
    entry.status = "learning";
    entry.updatedAt = new Date().toISOString();
    statusChanged = true;
  }
  state.selectedWord = word;
  saveState();
  renderShell();
  updateReaderSelection();
  maybeAutoSpeakFocusedWord(word);
  
  if (word.includes(" ") && isFresh) {
    import("./views/reader.js").then(({ renderReader }) => {
      const scrollY = preserveScroll ? window.scrollY : 0;
      const readerScrollTop = preserveScroll ? (document.getElementById("reader-text")?.scrollTop || 0) : 0;
      renderReader();
      if (preserveScroll) {
        setTimeout(() => {
          window.scrollTo({ top: scrollY, behavior: "instant" });
          const rt = document.getElementById("reader-text");
          if (rt) rt.scrollTop = readerScrollTop;
          const tok = document.querySelector(`#reader-text .word-token[data-word="${CSS.escape(state.selectedWord)}"]`);
          if (tok) { tok.focus(); window.lastActiveToken = tok; }
        }, 0);
      }
    });
  } else if (statusChanged) {
    updateWordStatusInReader(word, entry.status);
  }
  
  if (state.currentView === "vocabulary") {
    renderVocabulary();
  }
}

function maybeAutoSpeakFocusedWord(word) {
  if (state.currentView !== "reader") return;
  if (state.preferences?.autoTtsOnWordFocus !== true) return;

  const active = document.activeElement?.classList?.contains("word-token")
    ? document.activeElement
    : (window.lastActiveToken && document.body.contains(window.lastActiveToken) ? window.lastActiveToken : null);
  if (!active || active.dataset.word !== word) return;

  const focusKey = `${word}|${active.dataset.wordIndex || ""}`;
  if (focusKey === lastAutoTtsFocusKey) return;
  lastAutoTtsFocusKey = focusKey;
  speakWord(word);
}

export function setWordStatus(word, status) {
  if (!STATUS_ORDER.includes(status)) return;
  const entry = getOrCreateEntry(word, getTextById(state.currentTextId)?.text || "");
  const previousStatus = entry.status;
  maybeAutoTranslateWord(word, entry);
  entry.status = status;
  entry.updatedAt = new Date().toISOString();
  saveState();
  renderShell();
  updateWordStatusInReader(word, status);
  if (state.currentView === "library") renderLibrary();
  if (state.currentView === "vocabulary") {
    renderVocabulary();
    renderReview();
  }
  if (state.currentView === "flashcards") {
    renderReview();
  }
}

export function updateWordField(word, field, value) {
  const entry = getOrCreateEntry(word);
  entry[field] = value;
  if (field === "translation") {
    delete entry.translationSource;
    if (String(value || "").trim()) {
      delete entry.translationAutoRejected;
    } else {
      entry.translationAutoRejected = true;
    }
  }
  entry.updatedAt = new Date().toISOString();
  saveState();
  if (state.currentView === "vocabulary" && field !== "translation") {
    renderVocabulary();
  }
}
export function deleteWord(word) {
  delete state.vocab[word];
  initialVocabKeys.delete(word);
  if (state.selectedWord === word) state.selectedWord = null;
  saveState();
  if (state.currentView === "reader") {
    renderShell();
    updateReaderSelection();
    updateWordStatusInReader(word, "new");
  } else if (state.currentView === "vocabulary") {
    renderShell();
    renderVocabulary();
    renderReview();
  } else {
    render();
  }
  showToast(t("toast.wordRemoved"));
}

export function ignoreWord(word) {
  setWordStatus(word, "ignored");
}

export function handleReviewAction(action) {
  if (action === "toggle") toggleReviewAnswer();
  if (action === "next") {
    state.reviewIndex = (state.reviewIndex || 0) + 1;
    hideReviewAnswer();
    saveState();
  }
  if (action === "prev") {
    state.reviewIndex = Math.max(0, (state.reviewIndex || 0) - 1);
    hideReviewAnswer();
    saveState();
  }
  renderReview();
}

export function setWordImage(word, imageUrl) {
  const entry = getOrCreateEntry(word);
  entry.imageUrl = imageUrl;
  entry.updatedAt = new Date().toISOString();
  saveState();
  if (state.currentView === "reader") updateReaderSelection();
  else if (state.currentView === "vocabulary" || state.currentView === "flashcards") {
    renderVocabulary();
    renderReview();
  }
}

export function removeWordImage(word) {
  const entry = getOrCreateEntry(word);
  delete entry.imageUrl;
  entry.updatedAt = new Date().toISOString();
  saveState();
  if (state.currentView === "reader") updateReaderSelection();
  else if (state.currentView === "vocabulary" || state.currentView === "flashcards") {
    renderVocabulary();
    renderReview();
  }
}
