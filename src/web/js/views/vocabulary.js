// Vocabulary + review view: orchestrator, re-exports from sub-modules.
import { state, saveState } from "../state.js";
import { getSentenceForWord } from "../tokenizer_v2.js";
import { ensureSM2Fields, SM2_DEFAULTS, FSRS_DEFAULTS, todayISO } from "../sm2.js";
import { sessionAddedWords } from "../vocabulary/vocab-list.js";

// Module-level state: answer visibility for review
export let reviewAnswerVisible = false;

export function toggleReviewAnswer() {
  reviewAnswerVisible = !reviewAnswerVisible;
}

export function hideReviewAnswer() {
  reviewAnswerVisible = false;
}

export function getOrCreateEntry(word, text = "") {
  if (!Object.hasOwn(state.vocab, word)) {
    state.vocab[word] = {
      status: "new",
      translation: "",
      note: "",
      examples: [],
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      interval: SM2_DEFAULTS.interval,
      repetition: SM2_DEFAULTS.repetition,
      efactor: SM2_DEFAULTS.efactor,
      stability: FSRS_DEFAULTS.stability,
      difficulty: FSRS_DEFAULTS.difficulty,
      srsAlgorithm: state.preferences?.srsAlgorithm || "sm2",
      nextDate: todayISO()
    };
    sessionAddedWords.add(word);
  } else {
    ensureSM2Fields(state.vocab[word]);
  }
  const context = getSentenceForWord(
    text,
    word,
    state.preferences.learningLanguage || "en",
    state.preferences.wordDetectionAlgorithm || "modern"
  );
  if (context && !state.vocab[word].examples?.includes(context)) {
    state.vocab[word].examples = [context, ...(state.vocab[word].examples || [])].slice(0, 3);
  }
  return state.vocab[word];
}

// Re-export the public vocabulary API used by the rest of the app.
export {
  renderVocabulary,
  loadMoreVocab
} from "../vocabulary/vocab-list.js";

export {
  renderReview,
  gradeReview,
  removeFromSrs
} from "../vocabulary/review-card.js";
