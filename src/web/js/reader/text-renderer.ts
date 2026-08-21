/**
 * Plain-text reader rendering: chunked HTML building, multi-word phrase matching,
 * word-token emission, pagination footer, scroll restoration.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t } from "../i18n.js";
import { classifyTokenOccurrences, normalizeWord } from "../tokenizer_v2.js";
import { restoreReaderPagePosition } from "./scroll.js";
import { renderWordPanel } from "./word-panel.js";
import { updateReaderSelection } from "./selection.js";
import { paginationHtml } from "./pagination.js";
import { applyPendingReaderPageFocus, applyPendingReaderWordFocus } from "./focus.js";
import { getSrsLevel } from "../reader-colors.js";
import { renderInlineBookmarkIndicators } from "./bookmarks.js";
import { spanCovers, type WhFormatSpan } from "./format-markers.js";
import type { TextToken, TokenClassification } from "../tokenizer_v2.js";

export interface RenderPlainTextOptions {
  current: WhText;
  tokens: TextToken[];
  globalWordIndexes: number[];
  globalCharOffsets: number[];
  /** Inline-format spans + absolute per-token offsets (see ReaderSession). */
  formatSpans?: WhFormatSpan[];
  tokenCharOffsets?: number[];
  classifications: ReadonlyMap<number, TokenClassification>;
  pageStartIndex: number;
  pageEndIndex: number;
  totalPages: number;
  scrollPerPageKey: string | null;
  savedPos: unknown;
}

const CHUNK_SIZE = 500;
let textRenderGeneration = 0;

export function renderPlainText({ current, tokens, globalWordIndexes, globalCharOffsets, formatSpans = [], tokenCharOffsets, classifications, pageStartIndex, pageEndIndex, totalPages, scrollPerPageKey, savedPos }: RenderPlainTextOptions): void {
  // Format spans need per-token offsets; without them markers are ignored.
  const hasFormats = formatSpans.length > 0 && Array.isArray(tokenCharOffsets);
  const pageTokens = tokens.slice(pageStartIndex, pageEndIndex);
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
      restoreReaderPagePosition(current.id, scrollPerPageKey, savedPos);
      updateReaderSelection({ keepVisible: false });
      renderInlineBookmarkIndicators(current.id);
      if (!applyPendingReaderWordFocus(els.readerText)) applyPendingReaderPageFocus(els.readerText);
      els.readerText.dataset.rendering = "0";
      els.readerText.removeAttribute("aria-busy");
      return;
    }

    let htmlChunk = "";
    let i = index;
    let tokensProcessed = 0;

    while (i < pageTokens.length && tokensProcessed < CHUNK_SIZE) {
      const part = pageTokens[i];
      const tokenStart = hasFormats ? tokenCharOffsets![pageStartIndex + i] : 0;
      const tokenEnd = hasFormats ? tokenStart + part.value.length : 0;
      if (part.type === "image") {
        htmlChunk += `<img src="/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(part.value)}" alt="${escapeHtml(t("reader.imageAlt"))}" class="img-block-center">`;
        i++;
        tokensProcessed++;
        continue;
      }
      if (part.type === "text") {
        // A gap token may sit inside a formatted phrase (e.g. between two
        // bold words) — style it so the phrase reads as one continuous span.
        if (hasFormats && tokenEnd > tokenStart && spanCovers(formatSpans, tokenStart, tokenEnd)) {
          const kind = spanCovers(formatSpans, tokenStart, tokenEnd, "bold")
            ? "fmt-bold"
            : "fmt-italic";
          htmlChunk += `<span class="${kind}">${escapeHtml(part.value)}</span>`;
        } else {
          htmlChunk += escapeHtml(part.value);
        }
        i++;
        tokensProcessed++;
        continue;
      }

      const word = normalizeWord(part.value);
      const classification = classifications.get(pageStartIndex + i) || { key: word, status: "new" };
      const entry = state.vocab[classification.key];
      const selected = state.selectedWord === classification.key || state.selectedWord === word ? "selected" : "";
      const globalIdx = globalWordIndexes[pageStartIndex + i];
      const charOffset = globalCharOffsets[pageStartIndex + i];
      // Dynamic learning colors (Wave perf): emit a level class instead of an
      // inline `--token-learning-bg` style per token — the CSS maps each
      // `learning-lvl-N` class to the Nth configured learning color variable.
      const learningLevel = classification.status === "learning"
        && state.preferences?.dynamicLearningColors === true
        ? getSrsLevel(entry)
        : 0;
      const levelClass = learningLevel > 0 ? ` learning-lvl-${learningLevel}` : "";
      // Word tokens carry their formatting as classes on the button itself —
      // the marker characters never reach this code path (stripped before
      // tokenization), so vocabulary identity and char offsets are unchanged.
      let fmtClass = "";
      if (hasFormats && spanCovers(formatSpans, tokenStart, tokenEnd)) {
        fmtClass = spanCovers(formatSpans, tokenStart, tokenEnd, "bold")
          ? " fmt-bold"
          : " fmt-italic";
      }
      htmlChunk += `<button class="word-token status-${classification.status}${levelClass}${fmtClass} ${selected}" type="button" tabindex="-1" data-word="${escapeHtml(classification.key)}" data-display-word="${escapeHtml(part.value)}" data-word-index="${globalIdx}" data-char-offset="${charOffset}">${escapeHtml(part.value)}</button>`;
      i += 1;
      tokensProcessed += 1;
    }

    els.readerText.insertAdjacentHTML("beforeend", htmlChunk);
    index = i;
    setTimeout(renderNextChunk, 0); // Allows UI to breathe
  }

  setTimeout(renderNextChunk, 0);
}
