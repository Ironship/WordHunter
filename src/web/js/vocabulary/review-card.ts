/**
 * Review card: flashcard rendering, grading, SRS meta.
 */
import { state, saveState, saveUiState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, clamp } from "../utils.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { applyReviewNative, isDue, todayISO } from "../sm2.js";
import { renderVocabulary, invalidateVocabListCache } from "./vocab-list.js";
import { renderReviewChart, renderReviewUpcoming } from "./review-chart.js";
import { setEntryStatus } from "./entry-state.js";
import { playReviewGradeSound, playStatusSound } from "../status-sounds.js";
import { formatHeadword } from "./article.js";
import { resolveVocabularyKey } from "../tokenizer_v2.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { speakWord } from "../tts.js";

import { reviewAnswerVisible } from "../views/vocabulary.js";

interface SrsMetaEntry {
  srsAlgorithm?: string;
  stability?: number;
  difficulty?: number;
  efactor?: number;
}

interface ReviewTranslationCard {
  word: string;
}

export type ReviewTransitionDirection = "next" | "previous";

interface ReviewQueueEntry extends WhVocabEntry {
  key: string;
  word: string;
  nextDate: string;
}

interface ReviewSession {
  date: string;
  profile: string;
  keys: string[];
}

let reviewSession: ReviewSession | null = null;
let lastAutoSpokenPresentation = "";
let reviewGradePending = false;
let pendingSummary: { entries: ReviewQueueEntry[]; today: string } | null = null;
let summaryScheduled = false;
// Per-session flashcard statistics (UI only, not persisted).
let sessionStats = { total: 0, remembered: 0 };
let lastReviewQueueEmpty = true;

function shuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

/**
 * Stable shuffled key order of the current review session (due cards only).
 * The upcoming list reuses it so the visible queue can't leak the
 * alphabetical insertion order of the deck.
 */
export function reviewSessionKeyOrder(): readonly string[] {
  return reviewSession ? [...reviewSession.keys] : [];
}

function buildReviewQueue(entries: readonly ReviewQueueEntry[], today: string): ReviewQueueEntry[] {
  const profile = effectiveLearningLanguage(state.preferences);
  const byKey = new Map(entries.filter((entry) => isDue(entry.nextDate, today)).map((entry) => [entry.key, entry]));
  if (!reviewSession || reviewSession.date !== today || reviewSession.profile !== profile) {
    reviewSession = { date: today, profile, keys: shuffle([...byKey.keys()]) };
    state.reviewIndex = 0;
  } else {
    const previousQueueLength = reviewSession.keys.length;
    reviewSession.keys = reviewSession.keys.filter((key) => byKey.has(key));
    if (previousQueueLength > 0 && reviewSession.keys.length === 0) state.reviewIndex = 0;
    const queued = new Set(reviewSession.keys);
    reviewSession.keys.push(...shuffle([...byKey.keys()].filter((key) => !queued.has(key))));
  }
  return reviewSession.keys.map((key) => byKey.get(key)).filter((entry): entry is ReviewQueueEntry => Boolean(entry));
}

function scheduleReviewSummary(entries: ReviewQueueEntry[], today: string): void {
  pendingSummary = { entries, today };
  if (summaryScheduled) return;
  summaryScheduled = true;
  const renderSummary = () => {
    summaryScheduled = false;
    const summary = pendingSummary;
    pendingSummary = null;
    if (!summary) return;
    renderReviewChart(summary.entries, summary.today);
    renderReviewUpcoming(summary.entries, summary.today);
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(renderSummary, { timeout: 500 });
  else setTimeout(renderSummary, 0);
}

function maybeAutoSpeakCard(card: ReviewQueueEntry, today: string, isReverse: boolean): void {
  if (state.currentView !== "flashcards" || state.preferences.autoTtsOnFlashcardOpen === false) return;
  if (isReverse && !reviewAnswerVisible) return;
  const side = isReverse ? "answer" : "front";
  const presentation = `${effectiveLearningLanguage(state.preferences)}|${today}|${card.key}|${side}`;
  if (presentation === lastAutoSpokenPresentation) return;
  lastAutoSpokenPresentation = presentation;
  queueMicrotask(() => {
    if (state.currentView === "flashcards") speakWord(formatHeadword(card.word, card.article));
  });
}

export function resetReviewPresentation(): void {
  lastAutoSpokenPresentation = "";
}

// The queue rebuild (filter + sort over the whole vocab) is the hot path on
// every grade; memoize it and invalidate explicitly on mutations.
let reviewQueueCache: {
  vocabRef: Record<string, WhVocabEntry>;
  today: string;
  autoAddLearningOnly: boolean;
  entries: ReviewQueueEntry[];
} | null = null;

export function renderReview(transition?: ReviewTransitionDirection): void {
  if (!els.reviewCard) return;
  const today = todayISO();
  const autoAddLearningOnly = state.preferences?.autoAddLearningOnly === true;
  let srsEntries: ReviewQueueEntry[];
  if (
    reviewQueueCache &&
    reviewQueueCache.vocabRef === state.vocab &&
    reviewQueueCache.today === today &&
    reviewQueueCache.autoAddLearningOnly === autoAddLearningOnly
  ) {
    srsEntries = reviewQueueCache.entries;
  } else {
    srsEntries = Object.entries(state.vocab)
      .filter(([, entry]) => {
        if (entry.status === "ignored" || entry.status === "known") return false;
        if (autoAddLearningOnly && entry.status === "new") return false;
        return true;
      })
      .map(([key, entry]) => ({ ...entry, key, word: entry.word || key, nextDate: entry.nextDate || today }))
      .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
    reviewQueueCache = { vocabRef: state.vocab, today, autoAddLearningOnly, entries: srsEntries };
  }
  const reviewWords = buildReviewQueue(srsEntries, today);

  // A new review session starts whenever the queue goes from empty to non-empty
  // (e.g. entering the flashcards view or re-entering after finishing).
  if (reviewWords.length > 0 && lastReviewQueueEmpty) {
    sessionStats = { total: 0, remembered: 0 };
  }
  lastReviewQueueEmpty = reviewWords.length === 0;

  scheduleReviewSummary(srsEntries, today);

  const labelEl = document.getElementById("review-reverse-label");
  if (labelEl) {
    const isReverse = !!state.preferences.reviewReverse;
    labelEl.textContent = isReverse ? t("vocab.reverseOrder") : t("vocab.normalOrder");
    labelEl.setAttribute("data-i18n", isReverse ? "vocab.reverseOrder" : "vocab.normalOrder");
  }

  if (!reviewWords.length) {
    if (sessionStats.total > 0) {
      renderSessionSummary();
    } else {
      els.reviewCard.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("vocab.reviewEyebrow"))}</p><h3>${escapeHtml(t("vocab.reviewEmptyHeading"))}</h3><p>${escapeHtml(t("vocab.reviewEmptyHint"))}</p><button type="button" class="secondary-button" data-open-view="reader">${escapeHtml(t("nav.reader"))}</button></div>`;
    }
    return;
  }

  const reviewIndex = clamp(state.reviewIndex || 0, 0, reviewWords.length - 1);
  if (reviewIndex !== state.reviewIndex) {
    state.reviewIndex = reviewIndex;
    void saveUiState();
  }
  const card = reviewWords[state.reviewIndex];
  const grades = [1, 2, 3, 4, 5];
  const ratingButtons = grades.map((q) => `
    <button class="status-button sm2-grade sm2-grade-${q}" type="button" data-sm2-grade="${q}" data-word="${escapeAttribute(card.key)}" title="${escapeAttribute(t(`sm2.grade${q}`))}" aria-label="${escapeAttribute(t(`sm2.grade${q}`))}">${q}</button>
  `).join("");

  const context = card.examples?.[0] || "";
  const displayContext = context.length > 120 ? context.slice(0, 117) + "…" : context;
  const isReverse = !!state.preferences.reviewReverse;

  let frontHtml = "";
  if (!isReverse) {
    frontHtml = `
      <strong class="review-icon">
        ${escapeHtml(formatHeadword(card.word, card.article))}
        <button class="secondary-button round-icon-btn-28" type="button" data-tts-word="${escapeAttribute(formatHeadword(card.word, card.article))}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" aria-label="${escapeAttribute(t("reader.ttsWordTitle"))}">
          ${icon("speaker", 14)}
        </button>
      </strong>
      ${context ? `
        <p class="review-context hint-italic-center">
          „${escapeHtml(displayContext)}”
          <button class="secondary-button round-icon-btn-24" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" aria-label="${escapeAttribute(t("vocab.readSentence"))}">
            ${icon("speaker", 12)}
          </button>
        </p>
      ` : ""}
    `;
  } else {
    frontHtml = `
      ${card.translation ? `
        <p class="review-translation-front review-title">
          ${escapeHtml(card.translation)}
        </p>
      ` : renderReviewTranslationInput(card)}
      ${context ? `
        <p class="review-context hint-italic-center">
          „${escapeHtml(maskHeadwordInSentence(displayContext, card.word, card.article))}”
        </p>
      ` : ""}
    `;
  }

  let imageHtml = "";
  if (card.imageUrl) {
    imageHtml = `
      <div class="review-image upload-zone-sm">
        <img src="${escapeAttribute(card.imageUrl)}" alt="${escapeAttribute(formatHeadword(card.word, card.article))}"  class="thumb-bordered" />
        <button class="word-image-remove review-image-remove" type="button" data-action="remove-image" data-word="${escapeAttribute(card.key)}" title="${escapeAttribute(t("reader.removeImage"))}" aria-label="${escapeAttribute(t("reader.removeImage"))}">×</button>
      </div>
    `;
  } else {
    imageHtml = `
      <div class="review-image-search m-t-05-center">
        <button class="secondary-button button-xs image-action-button" type="button" data-review-action="search-image" data-word="${escapeAttribute(card.key)}" title="${escapeAttribute(t("vocab.addImage"))}">
          ${icon("image", 14)}
          ${escapeHtml(t("vocab.addImage"))}
          <span class="shortcut-badge">I</span>
        </button>
        <div id="review-image-search-results-${escapeAttribute(card.key)}" class="m-t-025"></div>
      </div>
    `;
  }

  let backHtml = "";
  if (reviewAnswerVisible) {
    if (!isReverse) {
      backHtml = `
        ${card.translation ? `
          <p class="review-translation review-subtitle">${escapeHtml(card.translation)}</p>
        ` : renderReviewTranslationInput(card)}
        ${card.note ? `<p class="review-note stat-note">${escapeHtml(card.note)}</p>` : ""}
      `;
    } else {
      backHtml = `
        <strong class="review-icon-m-t-1">
          ${escapeHtml(formatHeadword(card.word, card.article))}
          <button class="secondary-button round-icon-btn-28" type="button" data-tts-word="${escapeAttribute(formatHeadword(card.word, card.article))}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" aria-label="${escapeAttribute(t("reader.ttsWordTitle"))}">
            ${icon("speaker", 14)}
          </button>
        </strong>
        ${context ? `
          <p class="review-context-unmasked hint-italic-center-m-t-05">
            „${escapeHtml(displayContext)}”
            <button class="secondary-button round-icon-btn-24" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" aria-label="${escapeAttribute(t("vocab.readSentence"))}">
              ${icon("speaker", 12)}
            </button>
          </p>
        ` : ""}
        ${card.note ? `<p class="review-note stat-note">${escapeHtml(card.note)}</p>` : ""}
      `;
    }
    backHtml = `<div id="review-card-answer" class="review-card-answer">${backHtml}</div>`;
  } else {
    backHtml = '<div id="review-card-answer" hidden></div>';
  }

  const scheduleMeta = formatSrsMeta(card);
  const transitionClass = transition ? ` flashcard-enter-${transition}` : "";
  const answerClass = reviewAnswerVisible ? " flashcard-answer-visible" : "";

  els.reviewCard.innerHTML = `
    <div class="flashcard-wrap${transitionClass}${answerClass}" data-answer-visible="${reviewAnswerVisible}">
      <div class="review-word" data-review-card-surface>
        <div>
          ${frontHtml}
          ${imageHtml}
          ${backHtml}
        </div>
      </div>
    </div>
    <div class="word-actions flex-wrap">
      <button class="secondary-button" type="button" data-dict-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("vocab.openDictionary"))}" aria-label="${escapeAttribute(t("vocab.openDictionary"))}">
        ${icon("book", 16)}
        <span class="shortcut-badge">M</span>
      </button>
      <button class="secondary-button" type="button" data-youglish-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}" aria-label="${escapeAttribute(t("reader.youglishWordTitle"))}">
        ${icon("video", 16)}
        <span class="shortcut-badge">Y</span>
      </button>
      <button class="secondary-button button-xs" type="button" data-review-action="ai-explain" data-word="${escapeAttribute(card.key)}" title="${escapeAttribute(t("reader.aiExplain"))}" aria-label="${escapeAttribute(t("reader.aiExplain"))}">
        ${icon("sparkles", 14)} ${escapeHtml(t("reader.aiExplain"))}
        <span class="shortcut-badge">Ctrl+E</span>
      </button>
      <button class="secondary-button" type="button" data-review-action="toggle" data-word="${escapeAttribute(card.key)}" aria-expanded="${reviewAnswerVisible}" aria-controls="review-card-answer">
        ${icon("eye", 16)}
        ${escapeHtml(reviewAnswerVisible ? t("vocab.reviewHide") : t("vocab.reviewShow"))}
        <span class="shortcut-badge">${escapeHtml(t("reader.keyEnter"))}</span>
      </button>
      <div class="flashcard-navigation" role="group">
        <button class="secondary-button" type="button" id="btn-flashcard-prev" data-review-action="prev" data-word="${escapeAttribute(card.key)}" ${reviewIndex === 0 ? "disabled" : ""}>
          ${icon("chevronLeft", 16)}
          ${escapeHtml(t("vocab.reviewPrev"))}
          <span class="shortcut-badge">←</span>
        </button>
        <button class="secondary-button" type="button" id="btn-flashcard-next" data-review-action="next" data-word="${escapeAttribute(card.key)}" ${reviewIndex === reviewWords.length - 1 ? "disabled" : ""}>
          ${escapeHtml(t("vocab.reviewNext"))}
          <span class="shortcut-badge">→</span>
          ${icon("chevronRight", 16)}
        </button>
      </div>
    </div>
    ${reviewAnswerVisible ? `
      <p class="muted-copy sm2-prompt">${escapeHtml(t("sm2.prompt"))}</p>
      <div class="sm2-grades">${ratingButtons}</div>
    ` : ""}
    <p class="ai-explanation review-ai-explanation" data-review-ai-explanation role="status" aria-live="polite" hidden></p>
    <p class="muted-copy">${reviewIndex + 1} / ${reviewWords.length} · ${escapeHtml(t("sm2.nextDue", { date: card.nextDate || today }))} · ${escapeHtml(scheduleMeta)}</p>
  `;
  maybeAutoSpeakCard(card, today, isReverse);
}

/** End-of-session summary shown after the last card is graded (UI only). */
function renderSessionSummary(): void {
  if (!els.reviewCard) return;
  const pct = sessionStats.total > 0 ? Math.round((sessionStats.remembered / sessionStats.total) * 100) : 0;
  els.reviewCard.innerHTML = `
    <div class="empty-state">
      <p class="eyebrow">${escapeHtml(t("vocab.reviewEyebrow"))}</p>
      <h3>${escapeHtml(t("review.sessionSummaryTitle"))}</h3>
      <p>${escapeHtml(t("review.sessionSummaryCount", { n: sessionStats.total }))}</p>
      <p>${escapeHtml(t("review.sessionSummaryAccuracy", { pct }))}</p>
      <button type="button" class="primary-button m-t-1" id="review-session-summary-done">${escapeHtml(t("review.sessionSummaryDone"))}</button>
    </div>
  `;
  document.getElementById("review-session-summary-done")?.addEventListener("click", () => {
    sessionStats = { total: 0, remembered: 0 };
    renderReview();
  });
}

export async function applyReviewGrade(word: string, quality: number): Promise<WhVocabEntry | null> {
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
  const entry = state.vocab[word];
  if (!entry) return null;
  const learningLanguage = state.preferences.learningLanguage;
  const startingUpdatedAt = entry.updatedAt;
  const now = new Date();
  const reviewedEntry = await applyReviewNative({ ...entry }, quality, now, state.preferences?.srsAlgorithm || "sm2");
  const currentEntry = state.profiles?.[learningLanguage]?.vocab?.[word];
  if (!currentEntry) return null;
  if (currentEntry.updatedAt !== startingUpdatedAt) return null;
  Object.assign(currentEntry, {
    repetition: reviewedEntry.repetition,
    interval: reviewedEntry.interval,
    efactor: reviewedEntry.efactor,
    stability: reviewedEntry.stability,
    difficulty: reviewedEntry.difficulty,
    nextDate: reviewedEntry.nextDate,
    lastReviewedAt: reviewedEntry.lastReviewedAt,
    srsAlgorithm: reviewedEntry.srsAlgorithm
  });
  const updatedAt = now.toISOString();
  let status = currentEntry.status;
  // Graduate to "known" only when the card is mature (interval >= 21 days).
  // The old rule (quality >= 4 after two repetitions) retired cards at
  // ~1-8 day intervals: the review queue never built future reviews, ease
  // factors never drifted, no card ever reached maturity, and the graphs
  // (forecast, ease distribution, mature/young) degraded to a single bucket.
  if (quality >= 4 && (currentEntry.interval ?? 0) >= 21) status = "known";
  else if (quality < 3) status = "learning";
  else if (currentEntry.status === "new") status = "learning";
  setEntryStatus(currentEntry, status, updatedAt);
  invalidateVocabListCache();
  // A first transition to Learning must not replace the schedule just computed by FSRS/SM-2.
  currentEntry.nextDate = reviewedEntry.nextDate;
  return currentEntry;
}

export async function gradeReview(word: string, quality: number): Promise<void> {
  if (reviewGradePending || quality < 1 || quality > 5) return;
  reviewGradePending = true;
  els.reviewCard?.setAttribute("aria-busy", "true");
  els.reviewCard?.querySelectorAll("[data-sm2-grade]").forEach((button: Element) => {
    if (button instanceof HTMLButtonElement) button.disabled = true;
  });
  try {
    const entry = await applyReviewGrade(word, quality);
    if (!entry) return;
    sessionStats.total += 1;
    if (quality >= 4) sessionStats.remembered += 1;
    playReviewGradeSound(quality);
    const { hideReviewAnswer } = await import("../views/vocabulary.js");
    hideReviewAnswer();
    reviewQueueCache = null;
    renderReview();
    // A11y (Wave 1B): grading replaced the card via innerHTML, so focus was
    // dropped on body. Move it to the next card's reveal button (or the
    // end-of-session summary button) so keyboard review can continue.
    focusAfterReviewRender();
  } finally {
    reviewGradePending = false;
    els.reviewCard?.removeAttribute("aria-busy");
    els.reviewCard?.querySelectorAll("[data-sm2-grade]").forEach((button: Element) => {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    });
  }
}

/**
 * Restore focus after a review re-render (the graded card's DOM was replaced).
 * Prefers the "show answer" toggle so a keyboard-only session continues
 * 1-5 grade → Enter reveal → 1-5 grade; falls back to the end-of-session
 * summary button and finally to the card container.
 */
function focusAfterReviewRender(): void {
  const card = els.reviewCard;
  // Guard with feature checks instead of `instanceof HTMLElement`: headless
  // tests stub els.reviewCard as a plain object and the DOM globals may not
  // exist there (ReferenceError), while in the browser HTMLElement is always
  // present. A `focus` method is exactly the capability we need either way.
  if (card && typeof (card as HTMLElement).focus === "function") {
    const toggle = card.querySelector<HTMLElement>('[data-review-action="toggle"]');
    if (toggle && typeof toggle.focus === "function" && !(toggle as HTMLButtonElement).disabled) {
      toggle.focus();
      return;
    }
  }
  const done = document.getElementById("review-session-summary-done");
  if (done && typeof done.focus === "function") {
    done.focus();
    return;
  }
  if (card && typeof (card as HTMLElement).focus === "function") card.focus();
}

export function removeFromSrs(word: string): void {
  word = resolveVocabularyKey(word, state.vocab, effectiveLearningLanguage(state.preferences));
  const entry = state.vocab[word];
  if (!entry) return;
  const previousStatus = setEntryStatus(entry, "ignored");
  invalidateVocabListCache();
  if (previousStatus !== "ignored") playStatusSound("ignored");
  saveState();
  state.reviewIndex = 0;
  reviewQueueCache = null;
  renderReview();
  renderVocabulary();
}

// Mutation sites outside this module (deleteWord, setWordStatus, the
// word-editor dialog) change the queue's inputs without going through
// gradeReview/removeFromSrs; they must invalidate the memo or the review
// queue shows phantom/stale entries.
export function invalidateReviewQueueCache(): void {
  reviewQueueCache = null;
}

export function formatSrsMeta(entry: SrsMetaEntry): string {
  const mode = state.preferences?.srsAlgorithm === "fsrs" || entry.srsAlgorithm === "fsrs" ? "fsrs" : "sm2";
  if (mode === "fsrs") {
    const stability = Number.isFinite(entry.stability) ? entry.stability : 0;
    const difficulty = Number.isFinite(entry.difficulty) ? entry.difficulty : 5;
    return t("vocab.fsrsMeta", { stability: stability.toFixed(2), difficulty: difficulty.toFixed(2) });
  }
  const efactor = Number.isFinite(entry.efactor) ? entry.efactor : 2.5;
  return t("vocab.sm2Meta", { efactor: efactor.toFixed(2) });
}

function maskWordInSentence(sentence: string, word: string): string {
  if (!sentence || !word) return sentence;
  const escapedWord = word
    .replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
    .replace(/['’]/g, "['’]");
  try {
    let regex: RegExp;
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\uFAFF\uFF66-\uFF9F]/.test(word)) {
      regex = new RegExp(escapedWord, 'gi');
    } else {
      regex = new RegExp(`(?<!\\p{L})${escapedWord}(?!\\p{L})`, 'gui');
    }
    return sentence.replace(regex, '_____');
  } catch (e) {
    return sentence.replace(new RegExp(escapedWord, 'gi'), '_____');
  }
}

function maskHeadwordInSentence(sentence: string, word: string, article: unknown): string {
  const maskedWord = maskWordInSentence(
    maskWordInSentence(sentence, formatHeadword(word, article)),
    word
  );
  return maskWordInSentence(maskedWord, typeof article === "string" ? article.trim() : "");
}

function renderReviewTranslationInput(card: ReviewTranslationCard): string {
  return `
    <input
      class="vocab-translation-input review-translation-input empty"
      type="text"
      value=""
      data-word="${escapeAttribute(card.word)}"
      data-word-field="translation"
      placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
      aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: card.word }))}"
      autocomplete="off"
      spellcheck="false">
  `;
}
