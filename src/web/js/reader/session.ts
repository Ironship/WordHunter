import { classifyTokenOccurrences, getTokenStatsFromClassifications, tokenizeTextWithFormats } from "../tokenizer_v2.js";
import type { TextStats, TextToken, TokenClassification, Vocabulary } from "../tokenizer_v2.js";
import type { WhFormatSpan } from "./format-markers.js";

export interface ReaderSession {
  id: string | undefined;
  text: string;
  language: string;
  algorithm: string;
  tokens: TextToken[];
  globalWordIndexes: number[];
  globalCharOffsets: number[];
  /** Absolute char offset of EVERY token (words and gaps) in the stripped
   *  text — lets the renderer map format spans onto any token. */
  tokenCharOffsets: number[];
  wordTokenIndexes: number[];
  totalWords: number;
  /** Markdown-lite format spans (bold and italic) in the stripped-text
   *  coordinate system (the same coordinates globalCharOffsets uses);
   *  empty for unformatted text. */
  formatSpans: WhFormatSpan[];
  analysisRevision: number;
  classifications: Map<number, TokenClassification> | null;
  stats: TextStats | null;
}

let cachedSession: ReaderSession | null = null;

export function getReaderSession(current: Pick<WhText, "id" | "text"> | null | undefined, language: string, algorithm: string): ReaderSession {
  const text = String(current?.text || "");
  if (cachedSession
    && cachedSession.id === current?.id
    && cachedSession.text === text
    && cachedSession.language === language
    && cachedSession.algorithm === algorithm) {
    return cachedSession;
  }

  const { tokens, spans: formatSpans } = tokenizeTextWithFormats(text, language, algorithm);
  const globalWordIndexes = new Array(tokens.length).fill(-1);
  const globalCharOffsets = new Array(tokens.length).fill(-1);
  const tokenCharOffsets = new Array<number>(tokens.length).fill(0);
  const wordTokenIndexes: number[] = [];
  let totalWords = 0;
  let charOffset = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    tokenCharOffsets[index] = charOffset;
    if (tokens[index].type === "word") {
      wordTokenIndexes.push(index);
      globalWordIndexes[index] = totalWords++;
      globalCharOffsets[index] = charOffset;
    }
    charOffset += tokens[index].type === "image"
      ? `[IMG:${tokens[index].value}]`.length
      : tokens[index].value.length;
  }
  cachedSession = {
    id: current?.id,
    text,
    language,
    algorithm,
    tokens,
    globalWordIndexes,
    globalCharOffsets,
    tokenCharOffsets,
    wordTokenIndexes,
    totalWords,
    formatSpans,
    analysisRevision: -1,
    classifications: null,
    stats: null
  };
  return cachedSession;
}

export function clearReaderSession(): void {
  cachedSession = null;
}

export function getCachedReaderWord(
  current: Pick<WhText, "id" | "text">,
  language: string,
  algorithm: string,
  wordIndex: number | null
): { characterIndex: number; word: string } | null {
  if (!Number.isInteger(wordIndex) || wordIndex! < 0
    || !cachedSession
    || cachedSession.id !== current.id
    || cachedSession.text !== current.text
    || cachedSession.language !== language
    || cachedSession.algorithm !== algorithm) return null;
  const tokenIndex = cachedSession.wordTokenIndexes[wordIndex!];
  if (tokenIndex === undefined) return null;
  return {
    characterIndex: cachedSession.globalCharOffsets[tokenIndex],
    word: cachedSession.tokens[tokenIndex].value
  };
}

export function analyzeReaderSession(
  session: ReaderSession,
  vocab: Vocabulary,
  language: string,
  vocabularyRevision: number
): ReaderSession {
  if (session.analysisRevision === vocabularyRevision && session.classifications && session.stats) return session;
  session.classifications = classifyTokenOccurrences(session.tokens, vocab, language, vocabularyRevision);
  session.stats = getTokenStatsFromClassifications(session.tokens, session.classifications, language);
  session.analysisRevision = vocabularyRevision;
  return session;
}
