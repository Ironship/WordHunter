import { state } from "./state.js";
import { getAllBooks, bookTexts } from "./books.js";
import { normalizeWord, resolveTokenizerAlgorithm, tokenizeText } from "./tokenizer_v2.js";

const textWordCache = new Map();

export function getVocabularyTextOptions() {
  const seen = new Set();
  const options = [];
  const add = (item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    options.push({
      id: item.id,
      title: item.title || item.id,
      text: bookTexts.get(item.id) || item.text || item.sample || ""
    });
  };

  getAllBooks().forEach(add);
  (state.customTexts || []).forEach(add);
  return options;
}

export function getVocabularyTextById(textId) {
  if (!textId) return null;
  return getVocabularyTextOptions().find((item) => item.id === textId) || null;
}

function buildCacheKey(text, textId, lang, algorithm) {
  const mode = resolveTokenizerAlgorithm(algorithm);
  return [
    textId || "",
    lang || "",
    mode,
    String(text?.length || 0),
    String(text || "").slice(0, 200),
    String(text || "").slice(-200)
  ].join("|");
}

export function getTextVocabularyIndex(textId) {
  const textRecord = getVocabularyTextById(textId);
  if (!textRecord) return null;

  const lang = state.preferences.learningLanguage || "en";
  const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const text = textRecord.text || "";
  const cacheKey = buildCacheKey(text, textRecord.id, lang, algorithm);
  const cached = textWordCache.get(cacheKey);
  if (cached) return cached;

  const tokens = tokenizeText(text, lang, algorithm)
    .filter((part) => part.type === "word")
    .map((part) => normalizeWord(part.value))
    .filter(Boolean);
  const index = {
    text: textRecord,
    words: new Set(tokens),
    tokenLine: ` ${tokens.join(" ")} `
  };
  textWordCache.set(cacheKey, index);
  return index;
}

export function entryAppearsInText(word, textIndex) {
  if (!word || !textIndex) return false;
  const normalized = normalizeWord(word);
  if (!normalized) return false;
  if (!normalized.includes(" ")) return textIndex.words.has(normalized);
  const phrase = normalized.split(/\s+/).filter(Boolean).join(" ");
  return Boolean(phrase) && textIndex.tokenLine.includes(` ${phrase} `);
}

export function getVocabularyEntriesForText(textId) {
  const textIndex = getTextVocabularyIndex(textId);
  if (!textIndex) return [];
  return Object.entries(state.vocab)
    .filter(([word]) => entryAppearsInText(word, textIndex))
    .map(([word, entry]) => ({ word, ...entry }));
}
