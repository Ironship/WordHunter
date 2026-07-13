/**
 * Plain-text reader rendering: chunked HTML building, multi-word phrase matching,
 * word-token emission, pagination footer, scroll restoration.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t } from "../i18n.js";
import { classifyTokenOccurrences, normalizeWord } from "../tokenizer_v2.js";
import { restoreReaderScrollPosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";
import { paginationHtml } from "./pagination.js";
import { getLearningColor } from "../reader-colors.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import type { TextToken } from "../tokenizer_v2.js";

export interface RenderPlainTextOptions {
  current: WhText;
  tokens: TextToken[];
  globalWordIndexes: number[];
  pageStartIndex: number;
  pageEndIndex: number;
  totalPages: number;
  scrollPerPageKey: string | null;
  savedPos: unknown;
}

const CHUNK_SIZE = 500;
let textRenderGeneration = 0;

export function renderPlainText({ current, tokens, globalWordIndexes, pageStartIndex, pageEndIndex, totalPages, scrollPerPageKey, savedPos }: RenderPlainTextOptions): void {
  const pageTokens = tokens.slice(pageStartIndex, pageEndIndex);
  const classifications = classifyTokenOccurrences(tokens, state.vocab, effectiveLearningLanguage(state.preferences));
  let index = 0;
  els.readerText.innerHTML = "";

  const renderId = ++textRenderGeneration;
  els.readerText.dataset.renderId = String(renderId);

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
      const classification = classifications.get(pageStartIndex + i) || { key: word, status: "new" };
      const entry = state.vocab[classification.key];
      const selected = state.selectedWord === classification.key || state.selectedWord === word ? "selected" : "";
      const globalIdx = globalWordIndexes[pageStartIndex + i];
      const color = classification.status === "learning" ? getLearningColor(entry, state.preferences) : "";
      const style = color ? ` style="--token-learning-bg:${color}"` : "";
      htmlChunk += `<button class="word-token status-${classification.status} ${selected}" type="button" data-word="${escapeHtml(classification.key)}" data-word-index="${globalIdx}"${style}>${escapeHtml(part.value)}</button>`;
      i += 1;
      tokensProcessed += 1;
    }

    els.readerText.insertAdjacentHTML("beforeend", htmlChunk);
    index = i;
    setTimeout(renderNextChunk, 0); // Allows UI to breathe
  }

  setTimeout(renderNextChunk, 0);
}
