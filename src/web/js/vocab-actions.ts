import { getDurableStateRevision, state, saveState, saveUiState, initialVocabKeys } from "./state.js";
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
import { invalidateSuggestIndex } from "./reader/smart-suggest.js";
import { invalidateReviewQueueCache } from "./vocabulary/review-card.js";
import { canUseTranslationProvider, translateWithRetry } from "./translation-provider.js";
import { setEntryStatus } from "./vocabulary/entry-state.js";
import { playStatusSound } from "./status-sounds.js";
import { effectiveLearningLanguage, resolveProfileTranslationPair } from "./translator-preferences.js";
import { formatHeadword } from "./vocabulary/article.js";
import { resolveVocabularyKey } from "./tokenizer_v2.js";
import { getCachedReaderWord } from "./reader/session.js";

let lastAutoTtsFocusKey = "";
const pendingAutoTranslations = new WeakSet<WhVocabEntry>();
// Per-word cooldown after a failed auto-translation attempt (ms) — prevents
// hammering throttled translation endpoints when the user clicks around.
const AUTO_TRANSLATE_FAILURE_COOLDOWN_MS = 30_000;
const failedAutoTranslations = new Map<string, number>();
let autoTranslateFailureNotified = false;

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
  const lastFailure = failedAutoTranslations.get(word);
  if (lastFailure && Date.now() - lastFailure < AUTO_TRANSLATE_FAILURE_COOLDOWN_MS) return false;
  if (pendingAutoTranslations.has(entry)) return false;
  pendingAutoTranslations.add(entry);

  try {
    const pair = resolveProfileTranslationPair(state.preferences);
    const displayWord = entry.word || word;
    // Retries transient endpoint failures internally (once, after a short delay).
    const data = await translateWithRetry(displayWord, pair.fromCode, pair.toCode);
    // The entry object may have been replaced by a state reload while we waited —
    // resolve the CURRENT entry for this word and apply the result only if it
    // still needs a translation (fixes silently dropped translations).
    const currentEntry = state.vocab[word];
    if (!currentEntry
      || String(currentEntry.translation || "").trim()
      || isAutoTranslationRejected(currentEntry)) return false;
    const translated = String(data.translated || "").trim();
    if (translated && translated !== displayWord) {
      failedAutoTranslations.delete(word);
      autoTranslateFailureNotified = false;
      currentEntry.translation = translated;
      currentEntry.translationSource = data.engine || "translator";
      currentEntry.updatedAt = new Date().toISOString();
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
  } catch (error) {
    console.warn("Auto translation failed", error);
    failedAutoTranslations.set(word, Date.now());
    if (!autoTranslateFailureNotified) {
      autoTranslateFailureNotified = true;
      showToast(t("toast.autoTranslateUnavailable"), "error");
    }
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
  const language = effectiveLearningLanguage(state.preferences);
  const displayWord = String(rawWord || "").trim().normalize("NFC");
  const word = resolveVocabularyKey(displayWord || normalizeFn(rawWord), state.vocab, language);
  if (!word) return;
  const current = getTextById(state.currentTextId);
  const isFresh = !Object.hasOwn(state.vocab, word);
  const durableRevision = getDurableStateRevision();
  state.selectedWord = word;
  state.selectedWordIndex = Number.isInteger(wordIndex) && wordIndex >= 0 ? wordIndex : null;
  const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const cachedWord = current
    ? getCachedReaderWord(current, language, algorithm, state.selectedWordIndex)
    : null;
  const entry = getOrCreateEntry(
    displayWord || word,
    current?.text || "",
    state.selectedWordIndex,
    cachedWord?.characterIndex ?? null,
    cachedWord?.word || ""
  );
  maybeAutoTranslateWord(word, entry).catch((e) => console.warn("auto translate failed", e));
  let statusChanged = false;
  if (isFresh && state.preferences?.autoLearnOnClick) {
    setEntryStatus(entry, "learning");
    playStatusSound("learning");
    statusChanged = true;
    // autoLearnOnClick feeds the review queue (status + nextDate are memo
    // inputs) — invalidate so the new word shows up in the queue.
    invalidateReviewQueueCache();
  }
  if (getDurableStateRevision() !== durableRevision) saveState();
  else saveUiState();
  renderShell();
  updateReaderSelection();
  const spokenHeadword = formatHeadword(entry.word || displayWord || word, entry.article);
  if (options.forceSpeak) speakWord(spokenHeadword);
  else maybeAutoSpeakFocusedWord(word, spokenHeadword);
  
  if (word.includes(" ") && isFresh) {
    import("./reader/renderer.js").then(({ renderReader }) => {
      const scrollY = preserveScroll ? window.scrollY : 0;
      const readerText = document.getElementById("reader-text");
      const readerScrollTop = preserveScroll ? (readerText?.scrollTop || 0) : 0;
      if (readerText) {
        if (Number.isInteger(state.selectedWordIndex)) readerText.dataset.focusWordIndex = String(state.selectedWordIndex);
        else delete readerText.dataset.focusWordIndex;
        readerText.dataset.focusWord = state.selectedWord || "";
        delete readerText.dataset.focusAfterPageChange;
      }
      renderReader();
      if (preserveScroll) {
        setTimeout(() => {
          window.scrollTo({ top: scrollY, behavior: "instant" });
          const rt = document.getElementById("reader-text");
          if (rt) rt.scrollTop = readerScrollTop;
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

function maybeAutoSpeakFocusedWord(word: string, spokenHeadword = word): void {
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
  speakWord(spokenHeadword);
}

function isVocabStatus(status: string): status is WhVocabStatus {
  return STATUS_ORDER.some((candidate) => candidate === status);
}

export function setWordStatus(word: string, status: string): void {
  if (!isVocabStatus(status)) return;
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word, getTextById(state.currentTextId)?.text || "");
  const previousStatus = entry.status;
  if (hadEntry && previousStatus === status) return;
  maybeAutoTranslateWord(word, entry).catch((e) => console.warn("auto translate failed", e));
  setEntryStatus(entry, status);
  if (previousStatus !== status) playStatusSound(status);
  // The review queue depends on word statuses; the memo must not survive a
  // status change made outside gradeReview/removeFromSrs.
  invalidateReviewQueueCache();
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
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
  const hadEntry = Object.hasOwn(state.vocab, word);
  const entry = getOrCreateEntry(word);
  if (field === "article") {
    const article = typeof value === "string" ? value.trim() : "";
    if (hadEntry && Object.is(entry.article || "", article)) return;
    if (article) entry.article = article;
    else delete entry.article;
  } else {
    if (hadEntry && Object.is(entry[field], value)) return;
    entry[field] = value;
  }
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
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
  delete state.vocab[word];
  // In-place mutations keep the vocab reference, so the lazily built suggest
  // index and the review-queue memo would go stale (dead keys / phantoms).
  invalidateSuggestIndex();
  invalidateReviewQueueCache();
  failedAutoTranslations.delete(word);
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
    void saveUiState();
    renderReview("next");
    return;
  }
  if (action === "prev") {
    state.reviewIndex = Math.max(0, (state.reviewIndex || 0) - 1);
    hideReviewAnswer();
    void saveUiState();
    renderReview("previous");
    return;
  }
  renderReview();
}

export function setWordImage(word: string, imageUrl: unknown): void {
  if (typeof imageUrl !== "string") return;
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
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
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
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
