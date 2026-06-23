/**
 * Word panel: render the side panel and update word status in the reader.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, statusLabel } from "../utils.js";
import { icon, statusIcon } from "../icons.js";
import { getSentenceForWord, getTextStats } from "../tokenizer_v2.js";
import { STATUS_ORDER } from "../constants.js";
import { t } from "../i18n.js";
import { getOrCreateEntry } from "../views/vocabulary.js";
import { getTextById, renderTrackingSummary } from "./renderer.js";
import { getReaderSelectionText } from "./selection.js";
import { getSmartSuggestionHtml } from "./smart-suggest.js";
import { applyReviewGrade } from "../vocabulary/review-card.js";
import { getLearningColor } from "../reader-colors.js";
import { isInTextReviewDue } from "../sm2.js";

let inTextReviewWord = "";
let inTextAnswerVisible = false;
let inTextReviewCompleted = false;

function isTransientReaderRangeSelection() {
  const text = getReaderSelectionText();
  return !!text && !Object.hasOwn(state.vocab, state.selectedWord);
}

function resetInTextReview(word) {
  if (word !== inTextReviewWord) {
    inTextReviewWord = word;
    inTextAnswerVisible = false;
    inTextReviewCompleted = false;
  }
}

function renderTranslationEditor(entry, word, marginTop = "0") {
  return `
    <label style="margin-top: ${marginTop};">
      <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        ${escapeHtml(t("reader.translationLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">E</span>
      </span>
      <input type="text" value="${escapeAttribute(entry.translation || "")}" data-word="${escapeHtml(word)}" data-word-field="translation" placeholder="${escapeAttribute(t("reader.translationPlaceholder"))}">
    </label>
  `;
}

function renderInTextReview(entry, word, hasSmartSuggestion) {
  if (state.preferences?.inTextReview !== true || !isInTextReviewDue(entry)) {
    return renderTranslationEditor(entry, word, hasSmartSuggestion ? "0.75rem" : "0");
  }
  if (!inTextAnswerVisible) {
    return `
      <div class="in-text-review">
        <p class="muted-copy">${escapeHtml(t("sm2.inTextPrompt"))}</p>
        <button class="secondary-button" type="button" data-in-text-answer>
          ${escapeHtml(t("sm2.showAnswer"))}
          <span class="shortcut-badge">${escapeHtml(t("reader.keyEnter"))}</span>
        </button>
      </div>
    `;
  }
  const grades = [1, 2, 3, 4, 5].map((grade) => `
    <button class="status-button sm2-grade sm2-grade-${grade}" type="button" data-in-text-grade="${grade}" title="${escapeAttribute(t(`sm2.grade${grade}`))}">${grade}<span class="shortcut-badge">${grade}</span></button>
  `).join("");
  return `
    <div class="in-text-review">
      <p><strong>${escapeHtml(t("reader.translationLabel"))}:</strong> ${escapeHtml(entry.translation || t("vocab.reviewNoTranslation"))}</p>
      ${entry.translation ? "" : renderTranslationEditor(entry, word)}
      ${inTextReviewCompleted
        ? `<p class="muted-copy">${escapeHtml(t("sm2.inTextRecorded"))}</p>`
        : `<p class="muted-copy sm2-prompt">${escapeHtml(t("sm2.inTextRating"))}</p><div class="sm2-grades">${grades}</div>`}
    </div>
  `;
}

export function renderWordPanel(currentText) {
  const word = state.selectedWord;
  if (!word) {
    els.wordPanel.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">${escapeHtml(t("reader.wordPanelEyebrow"))}</p>
        <h2>${escapeHtml(t("reader.wordPanelHeading"))}</h2>
        <p>${escapeHtml(t("reader.wordPanelHint"))}</p>
      </div>
    `;
    return;
  }

  const isTransientRange = isTransientReaderRangeSelection();
  const entry = isTransientRange
    ? { status: "new", translation: "", note: "", imageUrl: "", examples: [] }
    : getOrCreateEntry(word, currentText.text);
  resetInTextReview(word);
  const context = entry.examples?.[0] || getSentenceForWord(
    currentText.text,
    word,
    state.preferences.learningLanguage || "en",
    state.preferences.wordDetectionAlgorithm || "modern"
  );

  const smartSuggestionHtml = getSmartSuggestionHtml(context, word);

  els.wordPanel.innerHTML = `
    <p class="eyebrow">${escapeHtml(statusLabel(entry.status))}</p>
    <h2 class="word-title">${escapeHtml(word)}</h2>
    <div class="word-form">
      <div class="status-options">
        ${STATUS_ORDER.map((status) => {
          const mapShortcut = { new: 1, learning: 2, known: 3, ignored: 4 };
          const isActive = entry.status === status;
          return `
            <button class="status-button status-${status} ${isActive ? "active" : ""}" type="button" data-word="${escapeHtml(word)}" data-set-status="${status}" aria-pressed="${isActive}" title="${escapeAttribute(statusLabel(status))}">
              ${statusIcon(status, 14)} ${escapeHtml(statusLabel(status))} <span class="shortcut-badge">${mapShortcut[status]}</span>
            </button>
          `;
        }).join("")}
      </div>
      ${smartSuggestionHtml}
      ${renderInTextReview(entry, word, !!smartSuggestionHtml)}
      <label>
        <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          ${escapeHtml(t("reader.noteLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">N</span>
        </span>
        <textarea rows="4" data-word="${escapeHtml(word)}" data-word-field="note" placeholder="${escapeAttribute(t("reader.notePlaceholder"))}">${escapeHtml(entry.note || "")}</textarea>
      </label>
      ${entry.imageUrl ? `
        <div class="word-image-preview" style="margin-top: 1rem; text-align: center; position: relative; display: inline-block; width: 100%;">
          <img src="${escapeAttribute(entry.imageUrl)}" style="max-height: 120px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line);" />
          <button type="button" data-action="remove-image" data-word="${escapeHtml(word)}" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 12px; line-height: 1; border: none; background: var(--red); color: white; cursor: pointer;">×</button>
        </div>
      ` : `
        <div class="word-image-search" style="margin-top: 1rem; text-align: center;">
          <button class="secondary-button button-xs image-action-button" type="button" data-action="search-image" data-word="${escapeHtml(word)}" title="${escapeAttribute(t("vocab.addImage"))}">
            ${icon("image", 14)}
            ${escapeHtml(t("vocab.addImage"))}
            <span class="shortcut-badge">I</span>
          </button>
          <div id="image-search-results-${escapeHtml(word)}" style="margin-top: 0.25rem;"></div>
        </div>
      `}
      <div class="context-box">${escapeHtml(context || t("reader.noContext"))}</div>
      <div class="word-actions">
        <button class="secondary-button" type="button" data-dict-word="${escapeHtml(word)}" title="${escapeAttribute(t("vocab.openDictionary"))}">${icon("book", 18)}<span class="shortcut-badge">M</span></button>
        <button class="secondary-button" type="button" data-tts-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}">${icon("speaker", 18)}<span class="shortcut-badge">${escapeHtml(t("reader.keySpace"))}</span></button>
        <button class="secondary-button" type="button" data-youglish-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}">${icon("video", 18)}<span class="shortcut-badge">Y</span></button>
        <button class="secondary-button" type="button" data-delete-word="${escapeHtml(word)}" title="${escapeAttribute(t("reader.removeWord"))}">${icon("trash", 18)}<span class="shortcut-badge">X</span></button>
      </div>
    </div>
  `;
  els.wordPanel.querySelector("[data-in-text-answer]")?.addEventListener("click", () => {
    inTextAnswerVisible = true;
    renderWordPanel(currentText);
  });
  els.wordPanel.querySelectorAll("[data-in-text-grade]").forEach((button) => button.addEventListener("click", async () => {
    const updated = await applyReviewGrade(word, Number(button.dataset.inTextGrade));
    if (!updated) return;
    inTextReviewCompleted = true;
    updateWordStatusInReader(word, updated.status);
  }));
}

export function updateWordStatusInReader(word, status) {
  if (!els.readerText) return;
  const tokens = els.readerText.querySelectorAll(`.word-token[data-word="${CSS.escape(word)}"]`);
  tokens.forEach(token => {
    token.classList.remove("status-new", "status-learning", "status-known", "status-ignored");
    token.classList.add(`status-${status}`);
    const color = status === "learning" ? getLearningColor(state.vocab[word], state.preferences) : "";
    if (color) token.style.setProperty("--token-learning-bg", color);
    else token.style.removeProperty("--token-learning-bg");
  });
  const current = getTextById(state.currentTextId);
  if (current && state.selectedWord === word) {
    renderWordPanel(current);
  }

  if (current) {
    const stats = getTextStats(
      current.text,
      state.vocab,
      state.preferences.learningLanguage || "en",
      state.preferences.wordDetectionAlgorithm || "modern"
    );
    renderTrackingSummary(stats);
    if (els.uniqueSummary) {
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });
    }
  }
}
