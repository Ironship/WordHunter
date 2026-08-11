/**
 * Reader in-text search (Ctrl+F): finds across the whole book, jumps pages,
 * highlights matches on the rendered page.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { getReaderSession } from "./session.js";
import { effectiveWordsPerPage, goToReaderPage } from "./pagination.js";
import { getTextById } from "./renderer.js";
import { isPdfOcrText } from "./pdf-ocr-renderer.js";

interface FindMatch {
  page: number;
  tokenIndex: number;
}

let findMatches: FindMatch[] = [];
let findIndex = -1;
let findQuery = "";
let findGeneration = 0;

function currentContext(): { session: ReturnType<typeof getReaderSession>; wordsPerPage: number } | null {
  const current = getTextById(state.currentTextId);
  if (!current || isPdfOcrText(current)) return null;
  const language = effectiveLearningLanguage(state.preferences);
  const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
  const session = getReaderSession(current, language, algorithm);
  const wordsPerPage = effectiveWordsPerPage(Number(state.preferences.wordsPerPage) || 1000);
  return { session, wordsPerPage };
}

function findAll(text: string, query: string): number[] {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const indexes: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    indexes.push(at);
    from = at + Math.max(1, needle.length);
  }
  return indexes;
}

function computeMatches(query: string): FindMatch[] {
  const context = currentContext();
  if (!context) return [];
  const { session, wordsPerPage } = context;
  // Word tokens with a mapped global offset, sorted by offset. The old
  // code scanned every token per match — O(matches x tokens) — stalling
  // on long books; the binary search brings it to O(matches x log tokens).
  const indexed: { offset: number; tokenIndex: number }[] = [];
  for (let i = 0; i < session.tokens.length; i += 1) {
    const token = session.tokens[i];
    if (token.type !== "word") continue;
    const offset = session.globalCharOffsets[i];
    if (offset >= 0) indexed.push({ offset, tokenIndex: i });
  }
  indexed.sort((a, b) => a.offset - b.offset);
  const matches: FindMatch[] = [];
  for (const start of findAll(session.text, query)) {
    // Largest token offset <= start (tokens are ordered, non-overlapping).
    let lo = 0;
    let hi = indexed.length - 1;
    let tokenIndex = -1;
    let offset = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (indexed[mid].offset <= start) {
        tokenIndex = indexed[mid].tokenIndex;
        offset = indexed[mid].offset;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (tokenIndex === -1) continue;
    const token = session.tokens[tokenIndex];
    if (start >= offset + token.value.length) continue;
    const wordIndex = session.globalWordIndexes[tokenIndex];
    matches.push({ page: Math.floor(wordIndex / wordsPerPage) + 1, tokenIndex });
  }
  return matches;
}

/** Highlight the current page's tokens that overlap the match range. */
function highlightPageMatch(tokenIndex: number): void {
  const context = currentContext();
  if (!context) return;
  const { session } = context;
  const token = session.tokens[tokenIndex];
  if (!token || token.type !== "word") return;
  const start = session.globalCharOffsets[tokenIndex];
  const end = start + token.value.length;
  let first: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>("#reader-text .word-token").forEach((el) => {
    const offset = Number(el.dataset.charOffset);
    const len = el.textContent?.length || 0;
    const overlaps = offset <= end && start < offset + len;
    el.classList.toggle("find-match", overlaps);
    if (overlaps && !first) first = el;
  });
  first?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function clearPageHighlights(): void {
  document.querySelectorAll<HTMLElement>("#reader-text .word-token.find-match").forEach((el) => {
    el.classList.remove("find-match");
  });
}

function updateCount(): void {
  if (els.readerFindCount) {
    els.readerFindCount.textContent = findMatches.length ? `${findIndex + 1} / ${findMatches.length}` : "0 / 0";
  }
}

/** Wait for the deferred reader render pass to finish after a page jump. */
function waitForReaderRender(generation: number, renderId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const el = document.getElementById("reader-text");
      if (!el) {
        resolve(false);
        return;
      }
      const done = el.dataset.renderId !== renderId && el.dataset.rendering === "0";
      if (done || Date.now() - started > 3000) {
        resolve(done);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function goToMatch(matchIndex: number): Promise<void> {
  if (!findMatches.length) return;
  const clamped = Math.max(0, Math.min(matchIndex, findMatches.length - 1));
  findIndex = clamped;
  const match = findMatches[clamped];
  const generation = ++findGeneration;
  const renderId = document.getElementById("reader-text")?.dataset.renderId || "";
  if (match.page !== state.readerPage) {
    goToReaderPage(match.page);
    await waitForReaderRender(generation, renderId);
    if (generation !== findGeneration) return;
  }
  highlightPageMatch(match.tokenIndex);
  updateCount();
}

function runFind(advance: boolean): void {
  const input = els.readerFindInput;
  if (!input) return;
  const query = input.value.trim();
  if (!query) {
    findGeneration += 1;
    findMatches = [];
    findIndex = -1;
    findQuery = "";
    clearPageHighlights();
    updateCount();
    return;
  }
  if (query !== findQuery) {
    findQuery = query;
    findMatches = computeMatches(query);
    findIndex = -1;
    if (findMatches.length) {
      void goToMatch(0);
    } else {
      updateCount();
    }
    return;
  }
  void goToMatch(findIndex + (advance ? 1 : -1));
}

function openReaderFind(): boolean {
  const bar = document.getElementById("reader-find-bar");
  if (!bar) return false;
  bar.hidden = false;
  const input = els.readerFindInput;
  if (input) {
    input.focus();
    input.select();
  }
  return true;
}

function closeReaderFind(): void {
  const bar = document.getElementById("reader-find-bar");
  if (bar) bar.hidden = true;
  findGeneration += 1;
  findMatches = [];
  findIndex = -1;
  findQuery = "";
  clearPageHighlights();
}

export function findNextMatch(): boolean {
  if (!findMatches.length) return false;
  void goToMatch(findIndex + 1);
  return true;
}

export function findPrevMatch(): boolean {
  if (!findMatches.length) return false;
  void goToMatch(findIndex - 1);
  return true;
}

export function bindReaderFindEvents(): void {
  const input = els.readerFindInput;
  if (!input) return;
  input.addEventListener("input", () => runFind(true));
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runFind(!event.shiftKey);
    } else if (event.key === "F3") {
      // Standard browser find keys, also while the find input is focused
      // (the global dispatcher skips reader keys inside fields).
      event.preventDefault();
      if (event.shiftKey) findPrevMatch();
      else if (!findNextMatch()) runFind(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeReaderFind();
      input.blur();
    }
  });
  els.readerFindNext?.addEventListener("click", () => findNextMatch());
  els.readerFindPrev?.addEventListener("click", () => findPrevMatch());
  els.readerFindClose?.addEventListener("click", () => closeReaderFind());
}

/** Ctrl+F entry: open the bar; a repeated Ctrl+F refocuses the input. */
export function toggleReaderFind(): boolean {
  const bar = document.getElementById("reader-find-bar");
  if (!bar || bar.hidden) return openReaderFind();
  const input = els.readerFindInput;
  if (input) {
    input.focus();
    input.select();
  }
  return true;
}
