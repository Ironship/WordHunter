import { state, saveState, initialVocabKeys } from "./state.js";
import { STATUS_ORDER } from "./constants.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, updateReaderSelection } from "./render.js";
import { getTextById } from "./reader/renderer.js";
import { updateWordStatusInReader } from "./reader/word-panel.js";
import { renderShell } from "./views/shell.js";
import { getOrCreateEntry, renderVocabulary, renderReview, hideReviewAnswer, toggleReviewAnswer } from "./views/vocabulary.js";
import { renderLibrary } from "./views/library.js";
import { speakWord } from "./tts.js";
import { canUseTranslationProvider, translateText } from "./translation-provider.js";
import { scheduleFirstLearningReview } from "./sm2.js";
import { setEntryStatus } from "./vocabulary/entry-state.js";
import { playStatusSound } from "./status-sounds.js";
import { resolveProfileTranslationPair } from "./translator-preferences.js";

let lastAutoTtsFocusKey = "";
const pendingAutoTranslations = new WeakSet<WhVocabEntry>();

interface SelectWordOptions {
  forceSpeak?: boolean;
}

function isAutoTranslationRejected(entry: WhVocabEntry): boolean {
  return entry.translationAutoRejected === true;
}

async function maybeAutoTranslateWord(word: string, entry: WhVocabEntry): Promise<boolean> {
  if (state.preferences?.autoTranslateWords !== true) return false;
  if (!canUseTranslationProvider()) return false;
  if (!entry || String(entry.translation || "").trim()) return false;
  if (isAutoTranslationRejected(entry)) return false;
  if (pendingAutoTranslations.has(entry)) return false;
  pendingAutoTranslations.add(entry);
  
  try {
    const pair = resolveProfileTranslationPair(state.preferences);
    const data = await translateText(word, pair.fromCode, pair.toCode);
    if (state.vocab[word] !== entry
      || String(entry.translation || "").trim()
      || isAutoTranslationRejected(entry)) return false;
    const translated = String(data.translated || "").trim();
    if (translated && translated !== word) {
      entry.translation = translated;
      entry.translationSource = data.engine || "translator";
      entry.updatedAt = new Date().toISOString();
      saveState();

      if (state.currentView === "reader" && state.selectedWord === word) {
        const translationField = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          `#word-panel [data-word-field="translation"][data-word="${CSS.escape(word)}"]`
        );
        if (translationField && !translationField.value.trim()) {
          translationField.value = translated;
        }
      }
      else if (state.currentView === "vocabulary") renderVocabulary();
      else if (state.currentView === "flashcards") renderReview();

      return true;
    }
  } catch (e) {
    console.warn("Auto translation failed", e);
  } finally {
    pendingAutoTranslations.delete(entry);
  }

  return false;
}

export function selectWord(
  rawWord: string,
  normalizeFn: (word: string) => string,
  preserveScroll = false,
  wordIndex: number | null = null,
  options: SelectWordOptions = {}
): void {
  const word = normalizeFn(rawWord);
  if (!word) return;
  const current = getTextById(state.currentTextId);
  const isFresh = !Object.hasOwn(state.vocab, word);
  state.selectedWord = word;
  state.selectedWordIndex = Number.isInteger(wordIndex) && wordIndex >= 0 ? wordIndex : null;
  const entry = getOrCreateEntry(word, current?.text || "", state.selectedWordIndex);
  maybeAutoTranslateWord(word, entry).catch((e) => console.warn("auto translate failed", e));
  let statusChanged = false;
  if (isFresh && state.preferences?.autoLearnOnClick) {
    setEntryStatus(entry, "learning");
    playStatusSound("learning");
    scheduleFirstLearningReview(entry);
    statusChanged = true;
  }
  saveState();
  renderShell();
  updateReaderSelection();
  if (options.forceSpeak) speakWord(word);
  else maybeAutoSpeakFocusedWord(word);
  
  if (word.includes(" ") && isFresh) {
    import("./reader/renderer.js").then(({ renderReader }) => {
      const scrollY = preserveScroll ? window.scrollY : 0;
      const readerScrollTop = preserveScroll ? (document.getElementById("reader-text")?.scrollTop || 0) : 0;
      renderReader();
      if (preserveScroll) {
        setTimeout(() => {
          window.scrollTo({ top: scrollY, behavior: "instant" });
          const rt = document.getElementById("reader-text");
          if (rt) rt.scrollTop = readerScrollTop;
          const tok = document.querySelector(`#reader-text .word-token[data-word="${CSS.escape(state.selectedWord)}"]`);
          if (tok instanceof HTMLElement) { tok.focus(); window.lastActiveToken = tok; }
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

function maybeAutoSpeakFocusedWord(word: string): void {
  if (state.currentView !== "reader") return;
  if (state.preferences?.autoTtsOnWordFocus !== true) return;

  const focusedElement = document.activeElement;
  const active = focusedElement instanceof HTMLElement && focusedElement.classList.contains("word-token")
    ? focusedElement
    : (window.lastActiveToken && document.body.contains(window.lastActiveToken) ? window.lastActiveToken : null);
  if (!active || active.dataset.word !== word) return;

  const focusKey = `${word}|${active.dataset.wordIndex || ""}`;
  if (focusKey === lastAutoTtsFocusKey) return;
  lastAutoTtsFocusKey = focusKey;
  speakWord(word);
}

function isVocabStatus(status: string): status is WhVocabStatus {
  return STATUS_ORDER.some((candidate) => candidate === status);
}

export function setWordStatus(word: string, status: string): void {
  if (!isVocabStatus(status)) return;
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word, getTextById(state.currentTextId)?.text || "");
  const previousStatus = entry.status;
  if (hadEntry && previousStatus === status) return;
  maybeAutoTranslateWord(word, entry).catch((e) => console.warn("auto translate failed", e));
  setEntryStatus(entry, status);
  if (previousStatus !== status) playStatusSound(status);
  if (status === "learning" && previousStatus !== "learning") scheduleFirstLearningReview(entry);
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

export function updateWordField(word: string, field: string, value: unknown): void {
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word);
  if (hadEntry && Object.is(entry[field], value)) return;
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
export function deleteWord(word: string): void {
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

export function ignoreWord(word: string): void {
  setWordStatus(word, "ignored");
}

export function handleReviewAction(action: string): void {
  if (action === "toggle") toggleReviewAnswer();
  if (action === "next") {
    state.reviewIndex = (state.reviewIndex || 0) + 1;
    hideReviewAnswer();
    saveState();
    renderReview("next");
    return;
  }
  if (action === "prev") {
    state.reviewIndex = Math.max(0, (state.reviewIndex || 0) - 1);
    hideReviewAnswer();
    saveState();
    renderReview("previous");
    return;
  }
  renderReview();
}

export function setWordImage(word: string, imageUrl: unknown): void {
  if (typeof imageUrl !== "string") return;
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word);
  if (hadEntry && Object.is(entry.imageUrl, imageUrl)) return;
  entry.imageUrl = imageUrl;
  entry.updatedAt = new Date().toISOString();
  saveState();
  if (state.currentView === "reader") updateReaderSelection();
  else if (state.currentView === "vocabulary" || state.currentView === "flashcards") {
    renderVocabulary();
    renderReview();
  }
}

export function removeWordImage(word: string): void {
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word);
  if (hadEntry && !Object.hasOwn(entry, "imageUrl")) return;
  delete entry.imageUrl;
  entry.updatedAt = new Date().toISOString();
  saveState();
  if (state.currentView === "reader") updateReaderSelection();
  else if (state.currentView === "vocabulary" || state.currentView === "flashcards") {
    renderVocabulary();
    renderReview();
  }
}
