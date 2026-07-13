import { state } from "./state.js";
import { getAllBooks, bookTexts } from "./books.js";
import { normalizeWord } from "./tokenizer_v2.js";
import {
  computeSignature,
  getCachedEntry,
  requestVocabIndex
} from "./vocab-index-client.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";

export interface VocabularyTextOption {
  id: string;
  title: string;
  text: string;
}

export interface TextVocabularyIndex {
  text: VocabularyTextOption;
  words: Set<string>;
  tokenLine: string;
}

type VocabularyTextSource = Partial<VocabularyTextOption> & {
  id?: string;
  sample?: string;
};

export function getVocabularyTextOptions(): VocabularyTextOption[] {
  const seen = new Set<string>();
  const options: VocabularyTextOption[] = [];
  const add = (item: VocabularyTextSource | null | undefined) => {
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

export function getVocabularyTextById(textId: string): VocabularyTextOption | null {
  if (!textId) return null;
  return getVocabularyTextOptions().find((item) => item.id === textId) || null;
}

export function getTextVocabularyIndex(textId: string): TextVocabularyIndex | null {
  const textRecord = getVocabularyTextById(textId);
  if (!textRecord) return null;

  const lang = effectiveLearningLanguage(state.preferences);
  const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const text = textRecord.text || "";
  const book = { id: textRecord.id };
  const signature = computeSignature(book, text, lang, algorithm);
  const cached = getCachedEntry(signature);
  if (cached) {
    return {
      text: textRecord,
      words: new Set<string>(cached.words as string[]),
      tokenLine: cached.tokenLine
    };
  }

  requestVocabIndex({ text, vocab: state.vocab, lang, algorithm, book });
  return null;
}

export async function loadTextVocabularyIndex(textId: string): Promise<TextVocabularyIndex | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const textRecord = getVocabularyTextById(textId);
    if (!textRecord) return null;
    const lang = effectiveLearningLanguage(state.preferences);
    const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
    const text = textRecord.text || "";
    const book = { id: textRecord.id };
    const entry = await requestVocabIndex({ text, vocab: state.vocab, lang, algorithm, book });
    if (!entry) continue;
    return {
      text: textRecord,
      words: new Set(entry.words),
      tokenLine: entry.tokenLine
    };
  }
  return null;
}

export function entryAppearsInText(word: unknown, textIndex: TextVocabularyIndex | null | undefined): boolean {
  if (!word || !textIndex) return false;
  const normalized = normalizeWord(word);
  if (!normalized) return false;
  if (!normalized.includes(" ")) return textIndex.words.has(normalized);
  const phrase = normalized.split(/\s+/).filter(Boolean).join(" ");
  return Boolean(phrase) && textIndex.tokenLine.includes(` ${phrase} `);
}
