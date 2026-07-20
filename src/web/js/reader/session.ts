import { tokenizeText } from "../tokenizer_v2.js";
import type { TextToken } from "../tokenizer_v2.js";

export interface ReaderSession {
  id: string | undefined;
  text: string;
  language: string;
  algorithm: string;
  tokens: TextToken[];
  globalWordIndexes: number[];
  globalCharOffsets: number[];
  totalWords: number;
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

  const tokens = tokenizeText(text, language, algorithm);
  const globalWordIndexes = new Array(tokens.length).fill(-1);
  const globalCharOffsets = new Array(tokens.length).fill(-1);
  let totalWords = 0;
  let charOffset = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === "word") {
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
    totalWords
  };
  return cachedSession;
}

export function clearReaderSession(): void {
  cachedSession = null;
}
