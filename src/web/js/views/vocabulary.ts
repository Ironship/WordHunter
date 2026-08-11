// Vocabulary + review view: orchestrator, re-exports from sub-modules.
import { state, saveState } from "../state.js";
import { getSentenceForWord, resolveVocabularyKey } from "../tokenizer_v2.js";
import { ensureSM2Fields, SM2_DEFAULTS, FSRS_DEFAULTS, todayISO } from "../sm2.js";
import { sessionAddedWords } from "../vocabulary/vocab-list.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { invalidateSuggestIndex } from "../reader/smart-suggest.js";

// Module-level state: answer visibility for review
export let reviewAnswerVisible: boolean = false;

export function toggleReviewAnswer(): void {
  reviewAnswerVisible = !reviewAnswerVisible;
}

export function hideReviewAnswer(): void {
  reviewAnswerVisible = false;
}

export function getOrCreateEntry(
  word: string,
  text = "",
  wordIndex: number | null = null,
  characterIndex: number | null = null,
  indexedWord = ""
): WhVocabEntry {
  const displayWord = String(word || "").trim().normalize("NFC");
  const key = resolveVocabularyKey(displayWord, state.vocab, effectiveLearningLanguage(state.preferences));
  if (!Object.hasOwn(state.vocab, key)) {
    // In-place add keeps the vocab reference — the lazily built suggest index
    // would miss the new key until the end of the session (duplicate
    // suggestions), so invalidate it.
    invalidateSuggestIndex();
    const createdAt = new Date().toISOString();
    state.vocab[key] = {
      word: displayWord,
      status: "new",
      translation: "",
      note: "",
      examples: [],
      addedAt: createdAt,
      updatedAt: createdAt,
      interval: SM2_DEFAULTS.interval,
      repetition: SM2_DEFAULTS.repetition,
      efactor: SM2_DEFAULTS.efactor,
      stability: FSRS_DEFAULTS.stability,
      difficulty: FSRS_DEFAULTS.difficulty,
      srsAlgorithm: state.preferences?.srsAlgorithm || "fsrs",
      nextDate: todayISO()
    };
    sessionAddedWords.add(key);
  } else {
    ensureSM2Fields(state.vocab[key]);
  }
  const context = getSentenceForWord(
    text,
    displayWord,
    effectiveLearningLanguage(state.preferences),
    state.preferences.wordDetectionAlgorithm || "modern",
    wordIndex,
    characterIndex,
    indexedWord
  );
  if (context && !state.vocab[key].examples?.includes(context)) {
    state.vocab[key].examples = [context, ...(state.vocab[key].examples || [])].slice(0, 3);
  }
  return state.vocab[key];
}

// Re-export the public vocabulary API used by the rest of the app.
export {
  renderVocabulary,
  loadMoreVocab
} from "../vocabulary/vocab-list.js";

export {
  renderReview,
  gradeReview,
  removeFromSrs,
  resetReviewPresentation
} from "../vocabulary/review-card.js";
