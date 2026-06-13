// Text tokenization and statistics. Independent of global state.
export function resolveTokenizerAlgorithm(value) {
  return value === "classic" ? "classic" : "modern";
}

function pushClassicTokens(block, parts) {
  const pattern = /\p{L}+(?:[-']\p{L}+)*/gu;
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

function pushModernTokens(block, lang, parts) {
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

export function tokenizeText(text, lang = "en", algorithm = "modern") {
  if (!text) return [];
  const parts = [];
  const mode = resolveTokenizerAlgorithm(algorithm);
  
  const imgPattern = /\[IMG:[^\]]+\]/g;
  let lastIndex = 0;
  let match = imgPattern.exec(text);
  
  const processTextBlock = (block) => {
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
  
  const merged = [];
  for (const p of parts) {
    if (merged.length > 0 && merged[merged.length-1].type === "text" && p.type === "text") {
      merged[merged.length-1].value += p.value;
    } else {
      merged.push(p);
    }
  }
  return merged;
}


export function normalizeWord(value) {
  return String(value || "")
    .toLocaleLowerCase("de-DE")
    .replace(/[„“”".,!?;:()[\]{}<>«»]/g, "")
    .trim();
}

export function normalizeSearchVariants(value) {
  const raw = normalizeWord(value);
  const german = raw
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
  const ascii = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return Array.from(new Set([raw, german, ascii]));
}

export function normalizeSearch(value) {
  const variants = normalizeSearchVariants(value);
  return variants.join(" ");
}

function getClassicSentenceForWord(text, word) {
  if (!text || !word) return "";

  const lowerText = text.toLowerCase();
  const lowerWord = word.toLowerCase();
  const wordLen = lowerWord.length;

  const isLetter = (char) => {
    if (!char) return false;
    return /\p{L}/u.test(char);
  };

  let index = lowerText.indexOf(lowerWord);
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
        if (tokenizeText(sentence, "en", "classic").some(part => part.type === "word" && normalizeWord(part.value) === word)) {
          return sentence;
        }
      }
    }

    index = lowerText.indexOf(lowerWord, index + 1);
  }

  return "";
}

export function getSentenceForWord(text, word, lang = "en", algorithm = "modern") {
  if (resolveTokenizerAlgorithm(algorithm) === "classic") {
    return getClassicSentenceForWord(text, word);
  }
  if (!text || !word) return "";
  
  const lowerText = text.toLowerCase();
  const lowerWord = word.toLowerCase();
  const wordLen = lowerWord.length;
  
  const isLetter = (char) => {
    if (!char) return false;
    return /\p{L}/u.test(char);
  };

  const isBoundary = (char) => !char || !isLetter(char);

  // Maximum characters to show on each side of the word
  const MAX_CONTEXT_CHARS = 100;

  const isEndPunct = (char) => char === '.' || char === '!' || char === '?' || char === '。' || char === '！' || char === '？';
  const isParagraphBreak = (char, nextChar) => char === '\n' && (nextChar === '\n' || nextChar === '\r');

  let index = lowerText.indexOf(lowerWord);
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
        if (tokenizeText(sentence, lang, "modern").some(part => part.type === "word" && normalizeWord(part.value) === word)) {
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

export function getTextStats(text, vocab, lang = "en", algorithm = "modern") {
  const words = new Set(
    tokenizeText(text, lang, algorithm).filter((part) => part.type === "word").map((part) => normalizeWord(part.value)).filter(Boolean)
  );
  const stats = { unique: words.size, known: 0, learning: 0, ignored: 0, new: 0 };
  words.forEach((word) => {
    const status = vocab[word]?.status || "new";
    stats[status] = (stats[status] || 0) + 1;
  });
  return stats;
}

export function cleanGutenbergText(rawText) {
  let text = rawText.replace(/\r\n/g, "\n");
  const startMatch = text.match(/\*\*\* START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i);
  const endMatch = text.match(/\*\*\* END OF (THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*/i);
  if (startMatch) text = text.slice(startMatch.index + startMatch[0].length);
  if (endMatch) text = text.slice(0, endMatch.index);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
