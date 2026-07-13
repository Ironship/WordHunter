// Text tokenization and statistics. Independent of global state.
export type TokenType = "text" | "word" | "image";

export interface TextToken {
  type: TokenType;
  value: string;
}

export interface VocabEntry {
  status?: string;
  [key: string]: unknown;
}

export type Vocabulary = Record<string, VocabEntry | undefined>;

export interface TextStats {
  unique: number;
  known: number;
  learning: number;
  ignored: number;
  new: number;
}

type TokenizerAlgorithm = "classic" | "modern";
type TokenClassification = { key: string; status: string };

function resolveTokenizerAlgorithm(value: string): TokenizerAlgorithm {
  return value === "classic" ? "classic" : "modern";
}

function pushClassicTokens(block: string, parts: TextToken[]) {
  const pattern = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu;
  let last = 0;
  let match = pattern.exec(block);
  while (match) {
    if (match.index > last) {
      parts.push({ type: "text", value: block.slice(last, match.index) });
    }
    parts.push({ type: "word", value: match[0] });
    last = match.index + match[0].length;
    match = pattern.exec(block);
  }
  if (last < block.length) {
    parts.push({ type: "text", value: block.slice(last) });
  }
}

function pushModernTokens(block: string, lang: string, parts: TextToken[]) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(lang, { granularity: "word" });
    for (const segment of segmenter.segment(block)) {
      if (segment.isWordLike) {
        parts.push({ type: "word", value: segment.segment });
      } else {
        parts.push({ type: "text", value: segment.segment });
      }
    }
    return;
  }
  pushClassicTokens(block, parts);
}

export function tokenizeText(text: string, lang = "en", algorithm = "modern"): TextToken[] {
  if (!text) return [];
  const parts: TextToken[] = [];
  const mode = resolveTokenizerAlgorithm(algorithm);
  
  const imgPattern = /\[IMG:[^\]]+\]/g;
  let lastIndex = 0;
  let match = imgPattern.exec(text);
  
  const processTextBlock = (block: string) => {
    if (!block) return;
    if (mode === "classic") pushClassicTokens(block, parts);
    else pushModernTokens(block, lang, parts);
  };

  while (match) {
    if (match.index > lastIndex) {
      processTextBlock(text.slice(lastIndex, match.index));
    }
    parts.push({ type: "image", value: match[0].slice(5, -1) });
    lastIndex = match.index + match[0].length;
    match = imgPattern.exec(text);
  }
  if (lastIndex < text.length) {
    processTextBlock(text.slice(lastIndex));
  }
  
  const merged: TextToken[] = [];
  for (const p of parts) {
    if (merged.length > 0 && merged[merged.length-1].type === "text" && p.type === "text") {
      merged[merged.length-1].value += p.value;
    } else {
      merged.push(p);
    }
  }
  return merged;
}


export function normalizeWord(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[„“”".,!?;:()[\]{}<>«»]/g, "")
    .trim();
}

export function normalizeSearchVariants(value: unknown): string[] {
  const raw = normalizeWord(value);
  const german = raw
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
  const ascii = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return Array.from(new Set([raw, german, ascii]));
}

const GERMAN_SEPARABLE_PREFIXES = new Set([
  "ab", "an", "auf", "aus", "bei", "ein", "fest", "her", "herein", "hin", "hinaus",
  "los", "mit", "nach", "vor", "vorbei", "weg", "weiter", "zu", "zurück", "zusammen",
  "dran", "drauf", "raus", "rein", "rüber", "runter"
]);

export function findGermanSeparableVerbMatches(tokens: readonly TextToken[], vocab: Vocabulary, lang = "en"): Map<number, string> {
  const matches = new Map<number, string>();
  if (lang !== "de") return matches;
  const candidates = new Map<string, Array<{ key: string; prefix: string }>>();
  for (const key of Object.keys(vocab || {})) {
    const parts = key.split(/\s+/).map(normalizeWord).filter(Boolean);
    if (parts.length !== 2 || !GERMAN_SEPARABLE_PREFIXES.has(parts[1])) continue;
    const values = candidates.get(parts[0]) || [];
    values.push({ key, prefix: parts[1] });
    candidates.set(parts[0], values);
  }
  if (!candidates.size) return matches;

  const clauses: Array<Array<{ tokenIndex: number; word: string }>> = [];
  let clause: Array<{ tokenIndex: number; word: string }> = [];
  tokens.forEach((token, tokenIndex) => {
    if (token.type === "word") clause.push({ tokenIndex, word: normalizeWord(token.value) });
    if (token.type === "text" && /[.!?;,\n\r]/u.test(token.value)) {
      if (clause.length) clauses.push(clause);
      clause = [];
    }
  });
  if (clause.length) clauses.push(clause);

  for (const words of clauses) {
    if (words.length < 2) continue;
  const consumed = new Set<number>();
    for (let prefixIndex = 1; prefixIndex < words.length; prefixIndex++) {
      const prefix = words[prefixIndex];
      if (!GERMAN_SEPARABLE_PREFIXES.has(prefix.word) || consumed.has(prefix.tokenIndex)) continue;
      for (let index = prefixIndex - 1; index >= 0 && prefixIndex - index < 12; index--) {
        if (consumed.has(words[index].tokenIndex)) continue;
        const candidate = (candidates.get(words[index].word) || [])
          .find((value) => value.prefix === prefix.word);
        if (!candidate) continue;
        matches.set(words[index].tokenIndex, candidate.key);
        matches.set(prefix.tokenIndex, candidate.key);
        consumed.add(words[index].tokenIndex);
        consumed.add(prefix.tokenIndex);
        break;
      }
    }
  }
  return matches;
}

function getWordCharacterIndex(text: string, word: string, lang: string, algorithm: string, wordIndex: number | null) {
  if (!Number.isInteger(wordIndex) || wordIndex < 0) return null;
  const expectedParts = normalizeWord(word).split(/\s+/).filter(Boolean);
  let characterIndex = 0;
  let currentWordIndex = 0;
  for (const part of tokenizeText(text, lang, algorithm)) {
    const partIndex = text.indexOf(part.value, characterIndex);
    if (partIndex < 0) return null;
    characterIndex = partIndex + part.value.length;
    if (part.type !== "word") continue;
    if (currentWordIndex === wordIndex) {
      return expectedParts.includes(normalizeWord(part.value))
        ? { characterIndex: partIndex, word: part.value }
        : null;
    }
    currentWordIndex++;
  }
  return null;
}

function getClassicSentenceForWord(text: string, word: string, preferredIndex = -1): string {
  if (!text || !word) return "";

  const lowerText = text.toLowerCase();
  const lowerWord = word.toLowerCase();
  const normalizedWord = normalizeWord(word);
  const wordLen = lowerWord.length;

  const isLetter = (char: string) => {
    if (!char) return false;
    return /\p{L}/u.test(char);
  };

  let index = preferredIndex >= 0 ? preferredIndex : lowerText.indexOf(lowerWord);
  let limit = 10;

  while (index !== -1 && limit-- > 0) {
    const prevChar = index > 0 ? text[index - 1] : "";
    const nextChar = index + wordLen < text.length ? text[index + wordLen] : "";

    if (!isLetter(prevChar) && !isLetter(nextChar)) {
      let start = index;
      while (start > 0) {
        const char = text[start - 1];
        if (char === "." || char === "!" || char === "?") {
          break;
        }
        start--;
      }

      let end = index + wordLen;
      while (end < text.length) {
        const char = text[end];
        if (char === "." || char === "!" || char === "?") {
          end++;
          break;
        }
        end++;
      }

      const sentence = text.slice(start, end).trim();
      if (sentence) {
        if (tokenizeText(sentence, "en", "classic").some(part => part.type === "word" && normalizeWord(part.value) === normalizedWord)) {
          return sentence;
        }
      }
    }

    index = lowerText.indexOf(lowerWord, index + 1);
  }

  return "";
}

export function getSentenceForWord(text: string, word: string, lang = "en", algorithm = "modern", wordIndex: number | null = null): string {
  const indexedMatch = getWordCharacterIndex(text, word, lang, algorithm, wordIndex);
  const preferredIndex = indexedMatch?.characterIndex ?? -1;
  const contextWord = indexedMatch?.word || word;
  if (resolveTokenizerAlgorithm(algorithm) === "classic") {
    return getClassicSentenceForWord(text, contextWord, preferredIndex);
  }
  if (!text || !contextWord) return "";
  
  const lowerText = text.toLowerCase();
  const lowerWord = contextWord.toLowerCase();
  const normalizedContextWord = normalizeWord(contextWord);
  const wordLen = lowerWord.length;
  
  const isLetter = (char: string) => {
    if (!char) return false;
    return /\p{L}/u.test(char);
  };

  const isBoundary = (char: string) => !char || !isLetter(char);

  // Maximum characters to show on each side of the word
  const MAX_CONTEXT_CHARS = 100;

  const isEndPunct = (char: string) => char === '.' || char === '!' || char === '?' || char === '。' || char === '！' || char === '？';
  let index = preferredIndex >= 0 ? preferredIndex : lowerText.indexOf(lowerWord);
  let limit = 50;
  
  while (index !== -1 && limit-- > 0) {
    const prevChar = index > 0 ? text[index - 1] : "";
    const nextChar = index + wordLen < text.length ? text[index + wordLen] : "";
    
    const validMatch = (lang === "ja" || lang === "zh") ? true : (isBoundary(prevChar) && isBoundary(nextChar));
    
    const quoteOpeners = ['「', '"', '（', '(', '«', '[', '{', '”'];
    const quoteClosers = ['」', '"', '）', ')', '»', ']', '}', '“'];
    
    if (validMatch) {
      // Scan backwards: prefer sentence boundary, paragraph break, or MAX_CONTEXT_CHARS limit
      let start = index;
      let qDepth = 0;
      let charsBack = 0;
      while (start > 0 && charsBack < MAX_CONTEXT_CHARS) {
        const char = text[start - 1];
        if (quoteClosers.includes(char)) qDepth++;
        if (quoteOpeners.includes(char)) qDepth = Math.max(0, qDepth - 1);
        // Paragraph break (double newline) is a hard stop
        if (start > 1 && (text[start - 2] === '\n' && (char === '\n' || char === '\r'))) {
          break;
        }
        if (qDepth === 0 && isEndPunct(char)) {
          break;
        }
        start--;
        charsBack++;
      }
      // If we hit the char limit mid-word, backtrack to a word boundary
      if (charsBack >= MAX_CONTEXT_CHARS && start > 0) {
        const rewind = text.slice(Math.max(0, start - 30), start + 10);
        const lastSpace = rewind.lastIndexOf(' ');
        if (lastSpace > 0) start = Math.max(0, start - 30 + lastSpace + 1);
      }
      
      // Scan forwards: prefer sentence boundary, paragraph break, or MAX_CONTEXT_CHARS limit
      let end = index + wordLen;
      qDepth = 0;
      let charsForward = 0;
      while (end < text.length && charsForward < MAX_CONTEXT_CHARS) {
        const char = text[end];
        if (quoteOpeners.includes(char)) qDepth++;
        if (quoteClosers.includes(char)) qDepth = Math.max(0, qDepth - 1);
        // Paragraph break (double newline) is a hard stop
        if (end + 1 < text.length && char === '\n' && (text[end + 1] === '\n' || text[end + 1] === '\r')) {
          end++;
          break;
        }
        if (qDepth === 0 && isEndPunct(char)) {
          end++;
          break;
        }
        end++;
        charsForward++;
      }
      // If we hit the char limit mid-word, stop at word boundary
      if (charsForward >= MAX_CONTEXT_CHARS) {
        const forwardText = text.slice(end, Math.min(end + 30, text.length));
        const nextSpace = forwardText.indexOf(' ');
        if (nextSpace > 0) end += nextSpace;
      }
      
      const sentence = text.slice(start, end).trim();
      if (sentence) {
        if (tokenizeText(sentence, lang, algorithm).some(part => part.type === "word" && normalizeWord(part.value) === normalizedContextWord)) {
          return sentence;
        }
      }
    }
    
    index = lowerText.indexOf(lowerWord, index + 1);
  }
  
  // Final fallback: if no sentence found, return a 400-char snippet around the word
  const firstIndex = lowerText.indexOf(lowerWord);
  if (firstIndex !== -1) {
    const snippetStart = Math.max(0, firstIndex - MAX_CONTEXT_CHARS);
    const snippetEnd = Math.min(text.length, firstIndex + wordLen + MAX_CONTEXT_CHARS);
    return text.slice(snippetStart, snippetEnd).trim();
  }
  
  return "";
}

export function classifyTokenOccurrences(tokens: readonly TextToken[], vocab: Vocabulary, lang = "en"): Map<number, TokenClassification> {
  const classifications = new Map<number, TokenClassification>();
  tokens.forEach((token, tokenIndex) => {
    if (token.type !== "word") return;
    const key = normalizeWord(token.value);
    if (!key) return;
    classifications.set(tokenIndex, { key, status: vocab?.[key]?.status || "new" });
  });

  const phrases = Object.entries(vocab || {})
    .filter(([word]) => word.includes(" "))
    .map(([key, entry]) => ({ key, words: key.split(/\s+/).map(normalizeWord).filter(Boolean), status: entry?.status || "new" }))
    .filter((phrase) => phrase.words.length > 1)
    .sort((a, b) => b.words.length - a.words.length);
  const phrasesByFirstWord = new Map<string, typeof phrases>();
  for (const phrase of phrases) {
    const values = phrasesByFirstWord.get(phrase.words[0]) || [];
    values.push(phrase);
    phrasesByFirstWord.set(phrase.words[0], values);
  }

  const claimed = new Set<number>();
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const first = classifications.get(tokenIndex);
    if (!first || claimed.has(tokenIndex)) continue;
    for (const phrase of phrasesByFirstWord.get(first.key) || []) {
      const wordTokenIndexes = [tokenIndex];
      let cursor = tokenIndex + 1;
      let wordOffset = 1;
      let blocked = false;
      while (wordOffset < phrase.words.length && cursor < tokens.length) {
        const token = tokens[cursor];
        if (token.type === "image" || (token.type === "text" && /[.!?;,\n\r。！？]/u.test(token.value))) {
          blocked = true;
          break;
        }
        if (token.type === "word") {
          if (claimed.has(cursor) || normalizeWord(token.value) !== phrase.words[wordOffset]) {
            blocked = true;
            break;
          }
          wordTokenIndexes.push(cursor);
          wordOffset += 1;
        }
        cursor += 1;
      }
      if (blocked || wordOffset !== phrase.words.length) continue;
      for (const index of wordTokenIndexes) {
        classifications.set(index, { key: phrase.key, status: phrase.status });
        claimed.add(index);
      }
      break;
    }
  }

  for (const [tokenIndex, key] of findGermanSeparableVerbMatches(tokens, vocab, lang)) {
    classifications.set(tokenIndex, { key, status: vocab?.[key]?.status || "new" });
  }

  return classifications;
}

export function getTokenStats(tokens: readonly TextToken[], vocab: Vocabulary, lang = "en"): TextStats {
  const words = tokens.filter((part) => part.type === "word").map((part) => normalizeWord(part.value)).filter(Boolean);
  const classifications = classifyTokenOccurrences(tokens, vocab, lang);
  const stats: TextStats = { unique: new Set(words).size, known: 0, learning: 0, ignored: 0, new: 0 };
  classifications.forEach(({ status }) => {
    const bucket: keyof Omit<TextStats, "unique"> = status === "known" || status === "learning" || status === "ignored"
      ? status
      : "new";
    stats[bucket] += 1;
  });
  return stats;
}

export function getTextStats(text: string, vocab: Vocabulary, lang = "en", algorithm = "modern"): TextStats {
  return getTokenStats(tokenizeText(text, lang, algorithm), vocab, lang);
}

export function cleanGutenbergText(rawText: string): string {
  let text = rawText.replace(/\r\n/g, "\n");
  const startMatch = text.match(/\*\*\* START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i);
  const endMatch = text.match(/\*\*\* END OF (THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*/i);
  if (startMatch) text = text.slice((startMatch.index ?? 0) + startMatch[0].length);
  if (endMatch) text = text.slice(0, endMatch.index ?? text.length);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
