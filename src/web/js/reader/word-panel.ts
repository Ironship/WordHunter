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
import {
  articleOptionsForLanguage,
  getSmartSuggestion,
  renderSmartSuggestionHtml,
  type ArticleSmartSuggestion
} from "./smart-suggest.js";
import { applyReviewGrade } from "../vocabulary/review-card.js";
import { getLearningColor } from "../reader-colors.js";
import { isInTextReviewDue } from "../sm2.js";
import { canUseTranslationProvider, translateText } from "../translation-provider.js";
import { beginElementBusy } from "../loading.js";
import { effectiveLearningLanguage, resolveProfileTranslationPair } from "../translator-preferences.js";
import { normalizeSelectedWordPanelItems } from "../state/normalize.js";
import type { VocabStatus } from "../constants.js";
import { formatHeadword } from "../vocabulary/article.js";

export interface UpdateWordStatusOptions {
  renderPanel?: boolean;
}

interface WordPanelEntry {
  status: VocabStatus;
  article?: string;
  translation?: string;
  note?: string;
  imageUrl?: string;
  examples?: string[];
  interval?: number;
  repetition?: number;
  efactor?: number;
  stability?: number;
  difficulty?: number;
  nextDate?: string;
  lastReviewedAt?: string;
  srsAlgorithm?: "sm2" | "fsrs";
}

let inTextReviewWord = "";
let inTextAnswerVisible = false;
let inTextReviewCompleted = false;
let contextTranslationGeneration = 0;
const ACTION_ITEM_IDS = new Set<WhSelectedWordPanelItemId>(["dictionary", "speech", "youglish", "copy", "edit", "remove"]);
const WORD_PANEL_STATUS_CLASSES = STATUS_ORDER.map((status) => `word-panel-status-${status}`);

function wordPanelElement(): HTMLElement {
  return els.wordPanel as HTMLElement;
}

function applyWordPanelStatus(status: VocabStatus | null): void {
  const panel = wordPanelElement();
  const host = panel.parentElement;
  panel.classList?.remove(...WORD_PANEL_STATUS_CLASSES);
  host?.classList.remove(...WORD_PANEL_STATUS_CLASSES);
  if (!status) {
    if (panel.dataset) delete panel.dataset.wordStatus;
    return;
  }
  const statusClass = `word-panel-status-${status}`;
  panel.classList?.add(statusClass);
  host?.classList.add(statusClass);
  if (panel.dataset) panel.dataset.wordStatus = status;
  const label = panel.querySelector?.<HTMLElement>(".word-panel-header .eyebrow");
  if (label) label.textContent = statusLabel(status);
  panel.querySelectorAll?.<HTMLButtonElement>("[data-set-status]").forEach((button) => {
    const active = button.dataset.setStatus === status;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function isTransientReaderRangeSelection() {
  const text = getReaderSelectionText();
  return !!text && !Object.hasOwn(state.vocab, state.selectedWord);
}

function resetInTextReview(word: string): void {
  if (word !== inTextReviewWord) {
    inTextReviewWord = word;
    inTextAnswerVisible = false;
    inTextReviewCompleted = false;
  }
}

function renderArticleEditor(
  entry: WordPanelEntry,
  word: string,
  suggestion: ArticleSmartSuggestion | null,
  isTransientRange: boolean
): string {
  if (isTransientRange) return "";
  const options = articleOptionsForLanguage()
    .map((article) => `<option value="${escapeAttribute(article)}"></option>`)
    .join("");
  return `
    <div class="word-article-editor" data-word-article-editor>
      <label>
        <span>${escapeHtml(t("reader.articleLabel"))}</span>
        <input
          class="word-article-input"
          type="text"
          data-word="${escapeAttribute(word)}"
          data-word-field="article"
          value="${escapeAttribute(entry.article || "")}"
          list="word-article-options"
          placeholder="${escapeAttribute(t("reader.articlePlaceholder"))}"
          aria-label="${escapeAttribute(t("reader.articleAria", { word }))}"
          autocomplete="off"
          spellcheck="false">
      </label>
      <datalist id="word-article-options">${options}</datalist>
      ${suggestion ? `
        <button class="secondary-button article-suggestion-button" type="button" data-suggest-article="${escapeAttribute(suggestion.article)}" data-suggest-word="${escapeAttribute(suggestion.word)}">
          ${escapeHtml(t("reader.smartSuggestArticleBtn", { article: suggestion.article }))}
          <span class="shortcut-badge">5</span>
        </button>
      ` : ""}
    </div>
  `;
}

function renderTranslationEditor(entry: WordPanelEntry, word: string, marginTop = "0"): string {
  return `
    <label style="margin-top: ${marginTop};">
      <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        ${escapeHtml(t("reader.translationLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">E</span>
      </span>
      <input type="text" value="${escapeAttribute(entry.translation || "")}" data-word="${escapeHtml(word)}" data-word-field="translation" placeholder="${escapeAttribute(t("reader.translationPlaceholder"))}">
    </label>
  `;
}

function renderInTextReview(entry: WordPanelEntry, word: string, hasSmartSuggestion: boolean): string {
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

function bindInTextReviewControls(currentText: WhText, word: string, entry: WordPanelEntry, hasSmartSuggestion: boolean): void {
  const panel = wordPanelElement();
  const refreshInTextReview = (nextEntry: WordPanelEntry = entry): void => {
    const review = panel.querySelector<HTMLElement>(".in-text-review");
    if (!review) {
      renderWordPanel(currentText);
      return;
    }
    review.outerHTML = renderInTextReview(nextEntry, word, hasSmartSuggestion);
    bindInTextReviewControls(currentText, word, nextEntry, hasSmartSuggestion);
  };

  panel.querySelector<HTMLElement>("[data-in-text-answer]")?.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    inTextAnswerVisible = true;
    refreshInTextReview(entry);
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-in-text-grade]").forEach((button) => button.addEventListener("click", async (event: MouseEvent) => {
    event.stopPropagation();
    const updated = await applyReviewGrade(word, Number(button.dataset.inTextGrade));
    if (!updated) return;
    inTextReviewCompleted = true;
    updateWordStatusInReader(word, updated.status, { renderPanel: false });
    refreshInTextReview(updated);
  }));
}

function bindContextTranslation(word: string, context: string): void {
  const panel = wordPanelElement();
  const button = panel.querySelector<HTMLElement>("[data-translate-context]");
  const output = panel.querySelector<HTMLElement>("[data-context-translation]");
  if (!button || !output || !context) return;
  button.addEventListener("click", async (event: MouseEvent) => {
    event.stopPropagation();
    if (!canUseTranslationProvider()) {
      output.hidden = false;
      output.textContent = t("translator.providerUnavailable");
      return;
    }
    const generation = ++contextTranslationGeneration;
    const releaseBusy = beginElementBusy(button, { disable: true });
    output.hidden = false;
    output.textContent = t("translator.translating");
    try {
      const pair = resolveProfileTranslationPair(state.preferences);
      const result = await translateText(
        context,
        pair.fromCode,
        pair.toCode
      );
      if (generation !== contextTranslationGeneration || state.selectedWord !== word) return;
      output.innerHTML = `<strong>${escapeHtml(t("reader.contextTranslationLabel"))}</strong> ${escapeHtml(result.translated || "")}`;
    } catch (error) {
      if (generation !== contextTranslationGeneration || state.selectedWord !== word) return;
      console.warn("Context translation failed", error);
      output.textContent = t("translator.error");
    } finally {
      releaseBusy();
    }
  });
}

function wordPanelItemLabel(id: WhSelectedWordPanelItemId): string {
  return t(`settings.wordPanelItems.${id}`);
}

function renderStatusItem(word: string, entry: WordPanelEntry): string {
  const shortcutMap: Record<VocabStatus, number> = { new: 1, learning: 2, known: 3, ignored: 4 };
  return `
    <div class="status-options" data-word-panel-item="status">
      ${STATUS_ORDER.map((status) => {
        const isActive = entry.status === status;
        return `
          <button class="status-button status-${status} ${isActive ? "active" : ""}" type="button" data-word="${escapeAttribute(word)}" data-set-status="${status}" aria-pressed="${isActive}" title="${escapeAttribute(statusLabel(status))}">
            ${statusIcon(status, 14)} ${escapeHtml(statusLabel(status))} <span class="shortcut-badge">${shortcutMap[status]}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderActionItem(
  id: WhSelectedWordPanelItemId,
  word: string,
  entry: WordPanelEntry,
  isTransientRange: boolean
): string {
  const escapedWord = escapeAttribute(word);
  const label = escapeAttribute(wordPanelItemLabel(id));
  if (id === "dictionary") {
    return `<button class="secondary-button" type="button" data-word-panel-item="dictionary" data-dict-word="${escapedWord}" title="${label}" aria-label="${label}">${icon("book", 18)}<span class="shortcut-badge">M</span></button>`;
  }
  if (id === "speech") {
    const title = escapeAttribute(t("reader.ttsWordTitle"));
    const spokenHeadword = escapeAttribute(formatHeadword(word, entry.article));
    return `<button class="secondary-button" type="button" data-word-panel-item="speech" data-tts-word="${spokenHeadword}" title="${title}" aria-label="${title}">${icon("speaker", 18)}<span class="shortcut-badge">${escapeHtml(t("reader.keySpace"))}</span></button>`;
  }
  if (id === "youglish") {
    const title = escapeAttribute(t("reader.youglishWordTitle"));
    return `<button class="secondary-button" type="button" data-word-panel-item="youglish" data-youglish-word="${escapedWord}" title="${title}" aria-label="${title}">${icon("video", 18)}<span class="shortcut-badge">Y</span></button>`;
  }
  if (id === "copy") {
    return `<button class="secondary-button" type="button" data-word-panel-item="copy" data-copy-word="${escapedWord}" title="${label}" aria-label="${label}">${icon("copy", 18)}</button>`;
  }
  if (id === "edit") {
    if (isTransientRange) return "";
    return `<button class="secondary-button" type="button" data-word-panel-item="edit" data-edit-word="${escapedWord}" title="${label}" aria-label="${label}">${icon("edit", 18)}</button>`;
  }
  if (id === "remove") {
    if (isTransientRange) return "";
    const title = escapeAttribute(t("reader.removeWord"));
    return `<button class="secondary-button" type="button" data-word-panel-item="remove" data-delete-word="${escapedWord}" title="${title}" aria-label="${title}">${icon("trash", 18)}<span class="shortcut-badge">X</span></button>`;
  }
  return "";
}

function renderContentItem(
  id: WhSelectedWordPanelItemId,
  word: string,
  entry: WordPanelEntry,
  context: string,
  smartSuggestionHtml: string,
  hasVisibleSmartSuggestion: boolean
): string {
  if (id === "status") return renderStatusItem(word, entry);
  if (id === "suggestion") {
    return smartSuggestionHtml
      ? `<div class="word-panel-item" data-word-panel-item="suggestion">${smartSuggestionHtml}</div>`
      : "";
  }
  if (id === "translation") {
    return `<div class="word-panel-item" data-word-panel-item="translation">${renderInTextReview(entry, word, hasVisibleSmartSuggestion)}</div>`;
  }
  if (id === "note") {
    return `
      <label data-word-panel-item="note">
        <span style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          ${escapeHtml(t("reader.noteLabel"))} <span class="shortcut-badge" style="font-size: 0.65rem; padding: 0.1rem 0.3rem;">N</span>
        </span>
        <textarea rows="4" data-word="${escapeAttribute(word)}" data-word-field="note" placeholder="${escapeAttribute(t("reader.notePlaceholder"))}">${escapeHtml(entry.note || "")}</textarea>
      </label>
    `;
  }
  if (id === "image") {
    return entry.imageUrl ? `
      <div class="word-image-preview" data-word-panel-item="image" style="margin-top: 1rem; text-align: center; position: relative; display: inline-block; width: 100%;">
        <img src="${escapeAttribute(entry.imageUrl)}" alt="${escapeAttribute(t("reader.imageAlt"))}" style="max-height: 120px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line);" />
        <button class="word-image-remove" type="button" data-action="remove-image" data-word="${escapeAttribute(word)}" aria-label="${escapeAttribute(t("reader.removeImage"))}" title="${escapeAttribute(t("reader.removeImage"))}">×</button>
      </div>
    ` : `
      <div class="word-image-search" data-word-panel-item="image" style="margin-top: 1rem; text-align: center;">
        <button class="secondary-button button-xs image-action-button" type="button" data-action="search-image" data-word="${escapeAttribute(word)}" title="${escapeAttribute(t("vocab.addImage"))}">
          ${icon("image", 14)}
          ${escapeHtml(t("vocab.addImage"))}
          <span class="shortcut-badge">I</span>
        </button>
        <div id="image-search-results-${escapeAttribute(word)}" style="margin-top: 0.25rem;"></div>
      </div>
    `;
  }
  if (id === "context") {
    return `
      <div class="context-box" data-word-panel-item="context">
        <span>${escapeHtml(context || t("reader.noContext"))}</span>
        ${context ? `<button class="ghost-button button-xs context-translate-button" type="button" data-translate-context>${icon("swap", 14)} ${escapeHtml(t("reader.translateContext"))}</button>` : ""}
        <p class="context-translation" data-context-translation role="status" aria-live="polite" hidden></p>
      </div>
    `;
  }
  return "";
}

function renderConfiguredItems(
  word: string,
  entry: WordPanelEntry,
  context: string,
  smartSuggestionHtml: string,
  isTransientRange: boolean,
  hasVisibleSmartSuggestion: boolean
): string {
  const parts: string[] = [];
  let actionParts: string[] = [];
  const flushActions = () => {
    if (!actionParts.length) return;
    parts.push(`<div class="word-actions">${actionParts.join("")}</div>`);
    actionParts = [];
  };

  for (const item of normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems)) {
    if (!item.visible) continue;
    if (ACTION_ITEM_IDS.has(item.id)) {
      const action = renderActionItem(item.id, word, entry, isTransientRange);
      if (action) actionParts.push(action);
      continue;
    }
    const content = renderContentItem(item.id, word, entry, context, smartSuggestionHtml, hasVisibleSmartSuggestion);
    if (!content) continue;
    flushActions();
    parts.push(content);
  }
  flushActions();
  return parts.join("");
}

export function renderWordPanel(currentText: WhText): void {
  contextTranslationGeneration += 1;
  const word = state.selectedWord;
  if (!word) {
    applyWordPanelStatus(null);
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
  const entry: WordPanelEntry = isTransientRange
    ? { status: "new", translation: "", note: "", imageUrl: "", examples: [] }
    : getOrCreateEntry(word, currentText.text, state.selectedWordIndex);
  applyWordPanelStatus(entry.status);
  resetInTextReview(word);
  const context = getSentenceForWord(
    currentText.text,
    word,
    effectiveLearningLanguage(state.preferences),
    state.preferences.wordDetectionAlgorithm || "modern",
    state.selectedWordIndex
  ) || entry.examples?.[0] || "";

  const smartSuggestion = getSmartSuggestion(context, word);
  const articleSuggestion = smartSuggestion?.kind === "article" ? smartSuggestion : null;
  const smartSuggestionHtml = smartSuggestion?.kind === "separable-verb"
    ? renderSmartSuggestionHtml(smartSuggestion)
    : "";
  const hasVisibleSmartSuggestion = !!smartSuggestionHtml && normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems)
    .some((item) => item.id === "suggestion" && item.visible);

  els.wordPanel.innerHTML = `
    <div class="word-panel-header">
      <div>
        <p class="eyebrow">${escapeHtml(statusLabel(entry.status))}</p>
        <h2 class="word-title" data-headword-word="${escapeAttribute(word)}">${escapeHtml(formatHeadword(word, entry.article))}</h2>
      </div>
      <button class="icon-button word-panel-close" type="button" data-close-word-panel aria-label="${escapeAttribute(t("reader.close"))}" title="${escapeAttribute(t("reader.close"))}">×</button>
    </div>
    ${renderArticleEditor(entry, word, articleSuggestion, isTransientRange)}
    <div class="word-form">
      ${renderConfiguredItems(word, entry, context, smartSuggestionHtml, isTransientRange, hasVisibleSmartSuggestion)}
    </div>
  `;
  bindInTextReviewControls(currentText, word, entry, hasVisibleSmartSuggestion);
  bindContextTranslation(word, context);
}

export function updateWordStatusInReader(word: string, status: VocabStatus, options: UpdateWordStatusOptions = {}): void {
  const { renderPanel = true } = options;
  if (state.selectedWord === word) applyWordPanelStatus(status);
  if (!els.readerText) return;
  const tokens = (els.readerText as HTMLElement).querySelectorAll<HTMLElement>(`.word-token[data-word="${CSS.escape(word)}"]`);
  tokens.forEach(token => {
    token.classList.remove("status-new", "status-learning", "status-known", "status-ignored");
    token.classList.add(`status-${status}`);
    const color = status === "learning" ? getLearningColor(state.vocab[word], state.preferences) : "";
    if (color) token.style.setProperty("--token-learning-bg", color);
    else token.style.removeProperty("--token-learning-bg");
  });
  const current = getTextById(state.currentTextId);
  if (current && state.selectedWord === word && renderPanel) {
    renderWordPanel(current);
  }

  if (current) {
    const stats = getTextStats(
      current.text,
      state.vocab,
      effectiveLearningLanguage(state.preferences),
      state.preferences.wordDetectionAlgorithm || "modern"
    );
    renderTrackingSummary(stats);
    if (els.uniqueSummary) {
      els.uniqueSummary.textContent = t("reader.uniqueSummary", { n: stats.unique });
    }
  }
}
