import {
  computeSignature,
  getCachedEntry,
  requestVocabIndex
} from "./vocab-index-client.js";

const EMPTY_STATS = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };

export function getCachedTextStats(book, text, vocab, lang = "en", algorithm = "modern") {
  if (!text) return EMPTY_STATS;

  const signature = computeSignature(book, text, lang, algorithm);
  const cached = getCachedEntry(signature);
  if (cached) return cached.stats;

  requestVocabIndex({ text, vocab, lang, algorithm, book });
  return EMPTY_STATS;
}

export function getCachedUniqueWordCount(book, text, lang = "en", algorithm = "modern") {
  if (!text) return 0;
  return getCachedEntry(computeSignature(book, text, lang, algorithm))?.stats.unique || 0;
}
