import { tokenizeText } from "../tokenizer_v2.js";

function tokenizedWords(text, lang, algorithm) {
  const source = String(text || "");
  const tokens = tokenizeText(source, lang, algorithm);
  const words = [];
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const start = source.indexOf(token.value, cursor);
    if (start < 0) continue;
    const end = start + token.value.length;
    cursor = end;
    if (token.type !== "word") continue;
    const punctuation = String(tokens[index + 1]?.type === "text" ? tokens[index + 1].value : "")
      .match(/^[^\p{L}\p{N}\s]+/u)?.[0] || "";
    words.push({ text: `${token.value}${punctuation}`, start, end });
  }
  return words;
}

function normalizedOverlayWord(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'’-]+/gu, "")
    .trim();
}

function matchingWordAnchors(sourceWords, targetWords) {
  const left = sourceWords.map((word) => normalizedOverlayWord(word?.text));
  const right = targetWords.map((word) => normalizedOverlayWord(word?.text));
  const columns = right.length + 1;
  const cells = (left.length + 1) * columns;
  if (cells > 4_000_000) return [];
  const lengths = new Uint32Array(cells);
  for (let l = left.length - 1; l >= 0; l -= 1) {
    for (let r = right.length - 1; r >= 0; r -= 1) {
      const index = l * columns + r;
      lengths[index] = left[l] && left[l] === right[r]
        ? lengths[(l + 1) * columns + r + 1] + 1
        : Math.max(lengths[(l + 1) * columns + r], lengths[index + 1]);
    }
  }
  const anchors = [];
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    if (left[l] && left[l] === right[r]) {
      anchors.push([l, r]);
      l += 1;
      r += 1;
    } else if (lengths[(l + 1) * columns + r] >= lengths[l * columns + r + 1]) {
      l += 1;
    } else {
      r += 1;
    }
  }
  return anchors;
}

function finiteRect(word) {
  const x = Number(word?.x);
  const y = Number(word?.y);
  const width = Number(word?.width);
  const height = Number(word?.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
}

function mergedOverlayWord(sourceWords, text) {
  const next = { ...(sourceWords[0] || {}), text };
  const rects = sourceWords.map(finiteRect).filter(Boolean);
  if (rects.length !== sourceWords.length || !rects.length) return next;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { ...next, x, y, width: right - x, height: bottom - y };
}

function splitOverlayWord(sourceWord, targetWords) {
  const rect = finiteRect(sourceWord);
  if (!rect || targetWords.length < 2) {
    return targetWords.map((word) => ({ ...sourceWord, text: word.text }));
  }
  const weights = targetWords.map((word) => Math.max(1, [...normalizedOverlayWord(word.text)].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  return targetWords.map((word, index) => {
    const width = index === targetWords.length - 1
      ? rect.width - offset
      : rect.width * (weights[index] / totalWeight);
    const next = { ...sourceWord, text: word.text, x: rect.x + offset, width: Math.max(0.5, width) };
    offset += width;
    return next;
  });
}

function reconcileWordSpan(sourceWords, targetWords) {
  if (!targetWords.length || !sourceWords.length) return [];
  if (sourceWords.length === targetWords.length) {
    return targetWords.map((word, index) => ({ ...sourceWords[index], text: word.text }));
  }
  if (targetWords.length < sourceWords.length) {
    return targetWords.map((word, index) => {
      const start = Math.floor(index * sourceWords.length / targetWords.length);
      const end = Math.floor((index + 1) * sourceWords.length / targetWords.length);
      return mergedOverlayWord(sourceWords.slice(start, Math.max(start + 1, end)), word.text);
    });
  }
  return sourceWords.flatMap((sourceWord, index) => {
    const start = Math.floor(index * targetWords.length / sourceWords.length);
    const end = Math.floor((index + 1) * targetWords.length / sourceWords.length);
    return splitOverlayWord(sourceWord, targetWords.slice(start, Math.max(start + 1, end)));
  });
}

export function reconcilePdfPageWords(sourceWords, correctedText, lang = "en", algorithm = "modern") {
  const source = (Array.isArray(sourceWords) ? sourceWords : [])
    .filter((word) => String(word?.text || "").trim());
  const target = tokenizedWords(correctedText, lang, algorithm);
  if (!source.length || !target.length) return [];
  const anchors = matchingWordAnchors(source, target);
  const result = [];
  let sourceStart = 0;
  let targetStart = 0;
  for (const [sourceIndex, targetIndex] of [...anchors, [source.length, target.length]]) {
    result.push(...reconcileWordSpan(
      source.slice(sourceStart, sourceIndex),
      target.slice(targetStart, targetIndex)
    ));
    if (sourceIndex < source.length && targetIndex < target.length) {
      result.push({ ...source[sourceIndex], text: target[targetIndex].text });
    }
    sourceStart = sourceIndex + 1;
    targetStart = targetIndex + 1;
  }
  return result;
}

export function findPdfSentenceRange(text, wordIndex, lang = "en", algorithm = "modern") {
  const source = String(text || "");
  const word = tokenizedWords(source, lang, algorithm)[wordIndex];
  if (!word) return null;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
    for (const segment of segmenter.segment(source)) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (word.start >= start && word.start < end) {
        const leading = segment.segment.match(/^\s*/u)?.[0].length || 0;
        const trailing = segment.segment.match(/\s*$/u)?.[0].length || 0;
        return { start: start + leading, end: end - trailing };
      }
    }
  }
  const left = source.slice(0, word.start).search(/[^.!?。！？\n\r]*$/u);
  const boundaryStart = left < 0 ? 0 : left;
  const rightMatch = source.slice(word.end).match(/^[\s\S]*?[.!?。！？]+[”"'»)]*/u);
  const boundaryEnd = rightMatch ? word.end + rightMatch[0].length : source.length;
  const start = boundaryStart + (source.slice(boundaryStart, boundaryEnd).match(/^\s*/u)?.[0].length || 0);
  const end = boundaryEnd - (source.slice(start, boundaryEnd).match(/\s*$/u)?.[0].length || 0);
  return { start, end };
}

export function replacePdfTextRange(text, range, replacement) {
  const source = String(text || "");
  const start = range?.start;
  const end = range?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > source.length) {
    return null;
  }
  return `${source.slice(0, start)}${String(replacement ?? "")}${source.slice(end)}`;
}

export function effectivePdfPageText(page) {
  if (page && Object.hasOwn(page, "correctedText")) {
    return String(page.correctedText || "").trim();
  }

  const text = String(page?.text || "").trim();
  if (text) return text;

  const lines = Array.isArray(page?.lines) ? page.lines : [];
  const lineText = lines
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean);
  if (lineText.length) return lineText.join("\n");

  return (Array.isArray(page?.words) ? page.words : [])
    .map((word) => String(word?.text || "").trim())
    .filter(Boolean)
    .join(" ");
}

export function countEffectivePdfPageWords(page, lang = "en", algorithm = "modern") {
  return tokenizeText(effectivePdfPageText(page), lang, algorithm)
    .filter((token) => token.type === "word")
    .length;
}

export function buildPdfDocumentText(pages) {
  return (Array.isArray(pages) ? pages : [])
    .map(effectivePdfPageText)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
