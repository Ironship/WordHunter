/**
 * Review card: flashcard rendering, grading, SRS meta.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, clamp } from "../utils.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { applyReviewNative, isDue, todayISO } from "../sm2.js";
import { renderVocabulary } from "./vocab-list.js";
import { renderReviewChart, renderReviewUpcoming } from "./review-chart.js";
import { setEntryStatus } from "./entry-state.js";

import { reviewAnswerVisible } from "../views/vocabulary.js";

export function renderReview() {
  if (!els.reviewCard) return;
  const today = todayISO();
  const srsEntries = Object.entries(state.vocab)
    .filter(([, entry]) => {
      if (entry.status === "ignored" || entry.status === "known") return false;
      if (state.preferences?.autoAddLearningOnly && entry.status === "new") return false;
      return true;
    })
    .map(([word, entry]) => ({ word, ...entry, nextDate: entry.nextDate || today }))
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const reviewWords = srsEntries.filter((entry) => isDue(entry.nextDate, today));

  renderReviewChart(srsEntries, today);
  renderReviewUpcoming(srsEntries, today);

  const labelEl = document.getElementById("review-reverse-label");
  if (labelEl) {
    const isReverse = !!state.preferences.reviewReverse;
    labelEl.textContent = isReverse ? t("vocab.reverseOrder") : t("vocab.normalOrder");
    labelEl.setAttribute("data-i18n", isReverse ? "vocab.reverseOrder" : "vocab.normalOrder");
  }

  if (!reviewWords.length) {
    els.reviewCard.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("vocab.reviewEyebrow"))}</p><h3>${escapeHtml(t("vocab.reviewEmptyHeading"))}</h3><p>${escapeHtml(t("vocab.reviewEmptyHint"))}</p></div>`;
    return;
  }

  state.reviewIndex = clamp(state.reviewIndex || 0, 0, reviewWords.length - 1);
  saveState();
  const card = reviewWords[state.reviewIndex];
  const grades = [0, 1, 2, 3, 4, 5];
  const ratingButtons = grades.map((q) => `
    <button class="status-button sm2-grade sm2-grade-${q}" type="button" data-sm2-grade="${q}" data-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t(`sm2.grade${q}`))}">${q}</button>
  `).join("");

  const context = card.examples?.[0] || "";
  const displayContext = context.length > 120 ? context.slice(0, 117) + "…" : context;
  const isReverse = !!state.preferences.reviewReverse;

  let frontHtml = "";
  if (!isReverse) {
    frontHtml = `
      <strong style="font-size: 2rem; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
        ${escapeHtml(card.word)}
        <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
          ${icon("speaker", 14)}
        </button>
      </strong>
      ${context ? `
        <p class="review-context" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.75rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
          „${escapeHtml(displayContext)}”
          <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
            ${icon("speaker", 12)}
          </button>
        </p>
      ` : ""}
    `;
  } else {
    frontHtml = `
      ${card.translation ? `
        <p class="review-translation-front" style="font-size: 1.5rem; font-weight: 500; color: var(--ink); margin-top: 0.5rem; display: block; width: 100%; text-align: center;">
          ${escapeHtml(card.translation)}
        </p>
      ` : renderReviewTranslationInput(card)}
      ${context ? `
        <p class="review-context" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.75rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
          „${escapeHtml(maskWordInSentence(displayContext, card.word))}”
        </p>
      ` : ""}
    `;
  }

  let imageHtml = "";
  if (card.imageUrl) {
    imageHtml = `
      <div class="review-image" style="margin-top: 0.5rem; text-align: center; position: relative; display: inline-block;">
        <img src="${escapeAttribute(card.imageUrl)}" style="max-height: 120px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line);" />
        <button type="button" data-action="remove-image" data-word="${escapeAttribute(card.word)}" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 12px; line-height: 1; border: none; background: var(--red); color: white; cursor: pointer;">×</button>
      </div>
    `;
  } else {
    imageHtml = `
      <div class="review-image-search" style="margin-top: 0.5rem; text-align: center;">
        <button class="secondary-button button-xs image-action-button" type="button" data-review-action="search-image" data-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("vocab.addImage"))}">
          ${icon("image", 14)}
          ${escapeHtml(t("vocab.addImage"))}
          <span class="shortcut-badge">I</span>
        </button>
        <div id="review-image-search-results-${escapeAttribute(card.word)}" style="margin-top: 0.25rem;"></div>
      </div>
    `;
  }

  let backHtml = "";
  if (reviewAnswerVisible) {
    if (!isReverse) {
      backHtml = `
        ${card.translation ? `
          <p class="review-translation" style="margin-top: 1rem; font-size: 1.2rem; font-weight: 500; color: var(--ink);">${escapeHtml(card.translation)}</p>
        ` : renderReviewTranslationInput(card)}
        ${card.note ? `<p class="review-note" style="margin-top: 0.5rem; color: var(--muted); font-size: 0.95rem;">${escapeHtml(card.note)}</p>` : ""}
      `;
    } else {
      backHtml = `
        <strong style="font-size: 2rem; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%; margin-top: 1rem;">
          ${escapeHtml(card.word)}
          <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
            ${icon("speaker", 14)}
          </button>
        </strong>
        ${context ? `
          <p class="review-context-unmasked" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.5rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
            „${escapeHtml(displayContext)}”
            <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
              ${icon("speaker", 12)}
            </button>
          </p>
        ` : ""}
        ${card.note ? `<p class="review-note" style="margin-top: 0.5rem; color: var(--muted); font-size: 0.95rem;">${escapeHtml(card.note)}</p>` : ""}
      `;
    }
  }

  const scheduleMeta = formatSrsMeta(card);

  els.reviewCard.innerHTML = `
    <div class="review-word">
      <div>
        ${frontHtml}
        ${imageHtml}
        ${backHtml}
      </div>
    </div>
    <div class="word-actions" style="flex-wrap: wrap;">
      <button class="secondary-button" type="button" data-dict-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("vocab.openDictionary"))}">
        ${icon("book", 16)}
        <span class="shortcut-badge">M</span>
      </button>
      <button class="secondary-button" type="button" data-youglish-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}">
        ${icon("video", 16)}
        <span class="shortcut-badge">Y</span>
      </button>
      <button class="secondary-button" type="button" data-review-action="toggle" data-word="${escapeAttribute(card.word)}">
        ${icon("eye", 16)}
        ${escapeHtml(reviewAnswerVisible ? t("vocab.reviewHide") : t("vocab.reviewShow"))}
        <span class="shortcut-badge">${escapeHtml(t("reader.keyEnter"))}</span>
      </button>
      <button class="secondary-button" type="button" id="btn-flashcard-prev" data-review-action="prev" data-word="${escapeAttribute(card.word)}" ${state.reviewIndex === 0 ? "disabled" : ""}>
        ${icon("chevronLeft", 16)}
        ${escapeHtml(t("vocab.reviewPrev"))}
        <span class="shortcut-badge">←</span>
      </button>
      <button class="secondary-button" type="button" id="btn-flashcard-next" data-review-action="next" data-word="${escapeAttribute(card.word)}">
        ${escapeHtml(t("vocab.reviewNext"))}
        <span class="shortcut-badge">→</span>
        ${icon("chevronRight", 16)}
      </button>
    </div>
    ${reviewAnswerVisible ? `
      <p class="muted-copy sm2-prompt">${escapeHtml(t("sm2.prompt"))}</p>
      <div class="sm2-grades">${ratingButtons}</div>
    ` : ""}
    <p class="muted-copy">${state.reviewIndex + 1} / ${reviewWords.length} · ${escapeHtml(t("sm2.nextDue", { date: card.nextDate || today }))} · ${escapeHtml(scheduleMeta)}</p>
  `;
}
export async function applyReviewGrade(word, quality) {
  const entry = state.vocab[word];
  if (!entry) return null;
  const now = new Date();
  await applyReviewNative(entry, quality, now, state.preferences?.srsAlgorithm || "sm2");
  const updatedAt = now.toISOString();
  let status = entry.status;
  if (quality >= 4 && entry.repetition >= 2) status = "known";
  else if (quality < 3) status = "learning";
  else if (entry.status === "new") status = "learning";
  setEntryStatus(entry, status, updatedAt);
  saveState();
  return entry;
}

export async function gradeReview(word, quality) {
  const entry = await applyReviewGrade(word, quality);
  if (!entry) return;
  const { hideReviewAnswer } = await import("../views/vocabulary.js");
  hideReviewAnswer();
  state.reviewIndex = 0;
  renderReview();
}

export function removeFromSrs(word) {
  const entry = state.vocab[word];
  if (!entry) return;
  setEntryStatus(entry, "ignored");
  saveState();
  state.reviewIndex = 0;
  renderReview();
  renderVocabulary();
}

export function formatSrsMeta(entry) {
  const mode = state.preferences?.srsAlgorithm === "fsrs" || entry.srsAlgorithm === "fsrs" ? "fsrs" : "sm2";
  if (mode === "fsrs") {
    const stability = Number.isFinite(entry.stability) ? entry.stability : 0;
    const difficulty = Number.isFinite(entry.difficulty) ? entry.difficulty : 5;
    return t("vocab.fsrsMeta", { stability: stability.toFixed(2), difficulty: difficulty.toFixed(2) });
  }
  const efactor = Number.isFinite(entry.efactor) ? entry.efactor : 2.5;
  return t("vocab.sm2Meta", { efactor: efactor.toFixed(2) });
}

function maskWordInSentence(sentence, word) {
  if (!sentence || !word) return sentence;
  const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  try {
    let regex;
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

function renderReviewTranslationInput(card) {
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
