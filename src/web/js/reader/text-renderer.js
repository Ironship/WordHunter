/**
 * Plain-text reader rendering: chunked HTML building, multi-word phrase matching,
 * word-token emission, pagination footer, scroll restoration.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t } from "../i18n.js";
import { findGermanSeparableVerbMatches, normalizeWord } from "../tokenizer_v2.js";
import { restoreReaderScrollPosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";
import { paginationHtml } from "./pagination.js";
import { getLearningColor } from "../reader-colors.js";

const CHUNK_SIZE = 500;
let textRenderGeneration = 0;

export function renderPlainText({ current, tokens, globalWordIndexes, pageStartIndex, pageEndIndex, totalPages, scrollPerPageKey, savedPos }) {
  const phrasesByFirstWord = new Map();
  Object.keys(state.vocab)
    .filter(k => k.includes(" "))
    .map(k => ({ key: k, words: k.split(" ") }))
    .sort((a, b) => b.words.length - a.words.length)
    .forEach((phrase) => {
      const candidates = phrasesByFirstWord.get(phrase.words[0]) || [];
      candidates.push(phrase);
      phrasesByFirstWord.set(phrase.words[0], candidates);
    });

  const pageTokens = tokens.slice(pageStartIndex, pageEndIndex);
  const separableVerbMatches = findGermanSeparableVerbMatches(
    pageTokens,
    state.vocab,
    state.preferences.learningLanguage || "en"
  );
  let index = 0;
  els.readerText.innerHTML = "";

  const renderId = ++textRenderGeneration;
  els.readerText.dataset.renderId = renderId;

  function renderNextChunk() {
    if (els.readerText.dataset.renderId !== String(renderId)) return;

    if (index >= pageTokens.length) {
      if (totalPages > 1) {
        els.readerText.insertAdjacentHTML("beforeend", paginationHtml(current.id, state.readerPage, totalPages, t));
      }
      renderWordPanel(current);
      // Restore per-page scroll if available, else fallback to text-level scroll
      const perPageScroll = state.readerScrollsPerPage?.[scrollPerPageKey];
      if (perPageScroll !== undefined) {
        els.readerText.scrollTop = perPageScroll;
      } else {
        const savedScroll = state.readerScrolls?.[current.id];
        if (savedScroll && typeof savedScroll === "object" && savedScroll.readerPage != null && savedScroll.readerPage !== state.readerPage) {
          els.readerText.scrollTop = 0;
        } else {
          restoreReaderScrollPosition(current.id, savedPos);
        }
      }
      updateReaderSelection();
      els.readerText.dataset.rendering = "0";
      els.readerText.removeAttribute("aria-busy");
      return;
    }

    let htmlChunk = "";
    let i = index;
    let tokensProcessed = 0;

    while (i < pageTokens.length && tokensProcessed < CHUNK_SIZE) {
      const part = pageTokens[i];
      if (part.type === "image") {
        htmlChunk += `<img src="/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(part.value)}" style="max-width: 100%; height: auto; display: block; margin: 1rem auto; border-radius: 6px;" alt="${escapeHtml(t("reader.imageAlt"))}">`;
        i++;
        tokensProcessed++;
        continue;
      }
      if (part.type === "text") {
        htmlChunk += escapeHtml(part.value);
        i++;
        tokensProcessed++;
        continue;
      }

      const word = normalizeWord(part.value);
      let matchedPhraseKey = separableVerbMatches.get(i) || null;
      let consumedTokens = 1;

      for (const phrase of matchedPhraseKey ? [] : (phrasesByFirstWord.get(word) || [])) {
          let match = true;
          let tokenOffset = 1;
          let wordOffset = 1;
          while (wordOffset < phrase.words.length && i + tokenOffset < pageTokens.length) {
            const nextToken = pageTokens[i + tokenOffset];
            if (nextToken.type === "text") {
              tokenOffset++;
              continue;
            }
            if (nextToken.type === "word" && normalizeWord(nextToken.value) === phrase.words[wordOffset]) {
              wordOffset++;
              tokenOffset++;
            } else {
              match = false;
              break;
            }
          }
          if (match && wordOffset === phrase.words.length) {
            matchedPhraseKey = phrase.key;
            consumedTokens = tokenOffset;
            break;
          }
      }

      let status = "new";
      let selected = "";
      let dataWord = escapeHtml(word);
      let entry = null;

      if (matchedPhraseKey) {
        const phrEntry = state.vocab[matchedPhraseKey];
        if (phrEntry) {
          entry = phrEntry;
          status = phrEntry.status;
          selected = state.selectedWord === matchedPhraseKey ? "selected" : "";
          dataWord = escapeHtml(matchedPhraseKey);
        }
      }
      if (!matchedPhraseKey || !Object.hasOwn(state.vocab, matchedPhraseKey)) {
        consumedTokens = 1;
        entry = state.vocab[word];
        status = entry ? entry.status : "new";
        selected = state.selectedWord === word ? "selected" : "";
      }

      for (let j = 0; j < consumedTokens; j++) {
        const consumedPart = pageTokens[i + j];
        if (consumedPart.type === "text") {
           htmlChunk += escapeHtml(consumedPart.value);
        } else {
           const pSelected = selected || (state.selectedWord === normalizeWord(consumedPart.value) ? "selected" : "");
           const globalIdx = globalWordIndexes[pageStartIndex + i + j];
           const color = status === "learning" ? getLearningColor(entry, state.preferences) : "";
           const style = color ? ` style="--token-learning-bg:${color}"` : "";
           htmlChunk += `<button class="word-token status-${status} ${pSelected}" type="button" data-word="${dataWord}" data-word-index="${globalIdx}"${style}>${escapeHtml(consumedPart.value)}</button>`;
        }
      }

      i += consumedTokens;
      tokensProcessed += consumedTokens;
    }

    els.readerText.insertAdjacentHTML("beforeend", htmlChunk);
    index = i;
    setTimeout(renderNextChunk, 0); // Allows UI to breathe
  }

  setTimeout(renderNextChunk, 0);
}
