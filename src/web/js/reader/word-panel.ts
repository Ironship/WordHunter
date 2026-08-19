/**
 * Word panel: render the side panel and update word status in the reader.
 */
import { getVocabularyRevision, state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, statusLabel } from "../utils.js";
import { icon, statusIcon } from "../icons.js";
import { IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT, STATUS_ORDER } from "../constants.js";
import { t, plural } from "../i18n.js";
import { getOrCreateEntry } from "../views/vocabulary.js";
import { appendAiExplanationToNote } from "../ai-note-append.js";
import { getTextById, renderTrackingSummary } from "./renderer.js";
import { getReaderSelectionText, getReaderWordTokens } from "./selection.js";
import { getSentenceForWord } from "../tokenizer_v2.js";
import {
  articleOptionsForLanguage,
  getSmartSuggestion,
  renderSmartSuggestionHtml,
  type ArticleSmartSuggestion
} from "./smart-suggest.js";
import { applyReviewGrade } from "../vocabulary/review-card.js";
import { getLearningColor } from "../reader-colors.js";
import { isInTextReviewDue } from "../sm2.js";
import { localizedTranslationError,  canUseTranslationProvider, translateWithRetry } from "../translation-provider.js";
import {
  aiExplanationConfigured,
  aiExplanationLanguagePair,
  collectPdfOcrImageContext,
  explainWord,
  formatAiExplanation,
  hasWordExplanation,
  markWordExplained
} from "../ai-explainer.js";
import { beginElementBusy } from "../loading.js";
import { effectiveLearningLanguage, resolveProfileTranslationPair } from "../translator-preferences.js";
import { normalizeSelectedWordPanelItems } from "../state/normalize.js";
import type { VocabStatus } from "../constants.js";
import { formatHeadword } from "../vocabulary/article.js";
import { playReviewGradeSound } from "../status-sounds.js";
import { analyzeReaderSession, getReaderSession } from "./session.js";

export interface UpdateWordStatusOptions {
  renderPanel?: boolean;
}

interface WordPanelEntry {
  word?: string;
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
let wordPanelRenderGeneration = 0;
const ACTION_ITEM_IDS = new Set<WhSelectedWordPanelItemId>(["dictionary", "speech", "youglish", "copy", "edit", "remove"]);
const WORD_PANEL_STATUS_CLASSES = STATUS_ORDER.map((status) => `word-panel-status-${status}`);

function wordPanelElement(): HTMLElement {
  return els.wordPanel as HTMLElement;
}

// Words with an auto-triggered AI explanation currently in flight, so a panel
// re-render cannot fire a duplicate request for the same word.
const aiExplainInFlight = new Set<string>();
// Generation counter for AI explanations only. Unlike the shared
// contextTranslationGeneration it is NOT bumped by panel re-renders, so an
// in-flight explanation survives e.g. a status click (the output element is
// replaced by the re-render, but the note append + cache still complete).
// Switching the selected word is still caught by `state.selectedWord !== word`.
let aiExplainGeneration = 0;

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
    <div class="word-article-editor" data-word-article-editor data-word-panel-item="article">
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
      <span class="row-between">
        ${escapeHtml(t("reader.translationLabel"))} <span class="shortcut-badge badge-tiny">E</span>
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
    const completedGuesses = Number(state.preferences?.inTextReviewCompletedGuesses);
    const showPrompt = !Number.isFinite(completedGuesses)
      || completedGuesses < IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT;
    return `
      <div class="in-text-review">
        ${showPrompt ? `<p class="muted-copy">${escapeHtml(t("sm2.inTextPrompt"))}</p>` : ""}
        <button class="secondary-button" type="button" data-in-text-answer>
          ${escapeHtml(t("sm2.showAnswer"))}
          <span class="shortcut-badge">${escapeHtml(t("reader.keyEnter"))}</span>
        </button>
      </div>
    `;
  }
  const grades = [1, 2, 3, 4, 5].map((grade) => `
    <button class="status-button sm2-grade sm2-grade-${grade}" type="button" data-in-text-grade="${grade}" aria-label="${escapeAttribute(t(`sm2.grade${grade}`))}" title="${escapeAttribute(t(`sm2.grade${grade}`))}">${grade}<span class="shortcut-badge">${grade}</span></button>
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
  const panelGeneration = wordPanelRenderGeneration;
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
    const grade = Number(button.dataset.inTextGrade);
    playReviewGradeSound(grade);
    const updated = await applyReviewGrade(word, grade);
    if (!updated) return;
    const completedGuesses = Number(state.preferences.inTextReviewCompletedGuesses);
    state.preferences.inTextReviewCompletedGuesses = Math.min(
      IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT,
      (Number.isFinite(completedGuesses) ? Math.max(0, Math.trunc(completedGuesses)) : 0) + 1
    );
    saveState();
    if (panelGeneration !== wordPanelRenderGeneration || state.selectedWord !== word) return;
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
      // Retries transient endpoint failures internally (once, after a short delay).
      const result = await translateWithRetry(
        context,
        pair.fromCode,
        pair.toCode
      );
      if (generation !== contextTranslationGeneration || state.selectedWord !== word) return;
      output.innerHTML = `<strong>${escapeHtml(t("reader.contextTranslationLabel"))}</strong> ${escapeHtml(result.translated || "")}`;
    } catch (error) {
      if (generation !== contextTranslationGeneration || state.selectedWord !== word) return;
      console.warn("Context translation failed", error);
      // Surface the backend reason (e.g. provider throttled, missing key)
      // so transient vs. configuration errors are distinguishable on device.
      const localized = localizedTranslationError(error);
      const reason = localized ? ` — ${localized}` : "";
      output.textContent = `${t("translator.error")}${reason}`;
    } finally {
      releaseBusy();
    }
  });
}

/** Context for the AI explainer: the saved example sentence, or for a
 * multi-word selection the sentence that contains the selection anchor. */
function aiExplainContext(word: string, context: string, isTransientRange: boolean): string {
  if (context) return context;
  if (!isTransientRange) return "";
  const current = getTextById(state.currentTextId);
  const bookText = current?.text || "";
  if (bookText) {
    const tokens = getReaderWordTokens();
    const anchorIndex = Number(state.readerSelectionRange?.anchor);
    const anchorToken = Number.isInteger(anchorIndex) && anchorIndex >= 0 ? tokens[anchorIndex] : null;
    const charOffset = anchorToken ? Number(anchorToken.dataset.charOffset) : null;
    const firstWord = anchorToken?.dataset.displayWord || word;
    const sentence = getSentenceForWord(
      bookText,
      firstWord,
      effectiveLearningLanguage(state.preferences),
      state.preferences.wordDetectionAlgorithm || "modern",
      null,
      Number.isInteger(charOffset) ? charOffset : null
    );
    if (sentence) return sentence;
  }
  return getReaderSelectionText();
}

/**
 * Append a finished AI explanation to the word's note so it persists with the
 * word instead of living only in the ephemeral panel output.
 *
 * Shared with the flashcards review card — see ../ai-note-append.ts for the
 * safety properties (flush-before-write, dedupe, live-textarea read).
 */
function bindAiExplain(word: string, context: string, isTransientRange: boolean): void {
  const panel = wordPanelElement();
  const button = panel.querySelector<HTMLButtonElement>("[data-ai-explain]");
  const output = panel.querySelector<HTMLElement>("[data-ai-explanation]");
  if (button) {
    // Bind on the button alone: if future markup ever renders the AI item
    // without the output box, maybeAutoTriggerAiExplain's button.click() must
    // still run the flow (otherwise the word would sit in aiExplainInFlight
    // forever with nothing consuming it).
    button.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      void runAiExplanation(word, context, isTransientRange, button, output);
    });
  }
  maybeAutoTriggerAiExplain(word, context, isTransientRange, button, output);
}

/**
 * Run the full AI explanation flow. `button`/`output` may be null when the
 * panel does not render the AI item (auto-trigger with a hidden item): the
 * explanation is then only persisted to the word note.
 */
async function runAiExplanation(
  word: string,
  context: string,
  isTransientRange: boolean,
  button: HTMLButtonElement | null,
  output: HTMLElement | null
): Promise<void> {
  if (!aiExplanationConfigured()) {
    if (output) {
      output.hidden = false;
      output.textContent = t("reader.aiExplainNotConfigured");
    }
    return;
  }
  const generation = ++aiExplainGeneration;
  const releaseBusy = button ? beginElementBusy(button, { disable: true }) : () => {};
  if (output) {
    output.hidden = false;
    output.textContent = t("translator.translating");
  }
  try {
    let imageContext: Awaited<ReturnType<typeof collectPdfOcrImageContext>> = null;
    if (!isTransientRange) {
      try {
        imageContext = await collectPdfOcrImageContext();
      } catch (error) {
        console.warn("AI explanation: no page image context", error);
      }
    }
    const pair = aiExplanationLanguagePair();
    const effectiveContext = imageContext?.context || aiExplainContext(word, context, isTransientRange);
    const result = await explainWord(
      {
        word,
        context: effectiveContext,
        from: pair.from,
        to: pair.to,
        image: imageContext?.image,
        rect: imageContext?.rect
      },
      (text) => {
        if (generation !== aiExplainGeneration || state.selectedWord !== word) return;
        if (!output) return;
        // Stream through the markdown renderer so bold/italic/lists are
        // visible immediately and a stalled stream never leaves raw "**"
        // markers on screen. formatAiExplanation escapes first.
        output.innerHTML = formatAiExplanation(text);
      }
    );
    if (generation !== aiExplainGeneration || state.selectedWord !== word) return;
    if (output) output.innerHTML = formatAiExplanation(result.explanation);
    if (!isTransientRange) {
      appendAiExplanationToNote(word, result.explanation);
      markWordExplained(word);
    }
  } catch (error) {
    if (generation !== aiExplainGeneration || state.selectedWord !== word) return;
    console.warn("AI explanation failed", error);
    if (output) output.textContent = t("reader.aiExplainError");
  } finally {
    releaseBusy();
    // Release the in-flight slot only when no newer run has started meanwhile
    // (a superseded run's finally must not clear the guard while the fresh
    // run is still streaming — that would allow a third request to start).
    if (generation === aiExplainGeneration) aiExplainInFlight.delete(word);
  }
}

/**
 * Auto-trigger: when the setting is enabled, a word that has never received
 * an AI explanation gets one automatically the moment its panel opens. The
 * regular flow is reused (streaming, cache, note append); when the AI panel
 * item is hidden the explanation is still fetched and persisted to the note.
 * Transient phrase selections never auto-trigger (no dictionary entry).
 */
function maybeAutoTriggerAiExplain(
  word: string,
  context: string,
  isTransientRange: boolean,
  button: HTMLButtonElement | null,
  output: HTMLElement | null
): void {
  if (isTransientRange) return;
  const preferences: Partial<WhPreferences> = state.preferences || {};
  if (preferences.aiExplanationAutoTrigger !== true) return;
  if (!aiExplanationConfigured()) return;
  if (hasWordExplanation(word)) return;
  if (aiExplainInFlight.has(word)) return;
  aiExplainInFlight.add(word);
  if (button && !button.disabled) {
    button.click();
    return;
  }
  // No visible AI item (or a disabled button): run headless — the note still
  // gets the explanation, and a visible output box would have been replaced
  // by the next render anyway.
  void runAiExplanation(word, context, isTransientRange, null, output);
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
  const displayWord = entry.word || word;
  const escapedDisplayWord = escapeAttribute(displayWord);
  const label = escapeAttribute(wordPanelItemLabel(id));
  if (id === "dictionary") {
    return `<button class="secondary-button" type="button" data-word-panel-item="dictionary" data-dict-word="${escapedDisplayWord}" title="${label}" aria-label="${label}">${icon("book", 18)}<span class="shortcut-badge">M</span></button>`;
  }
  if (id === "speech") {
    const title = escapeAttribute(t("reader.ttsWordTitle"));
    const spokenHeadword = escapeAttribute(formatHeadword(displayWord, entry.article));
    return `<button class="secondary-button" type="button" data-word-panel-item="speech" data-tts-word="${spokenHeadword}" title="${title}" aria-label="${title}">${icon("speaker", 18)}<span class="shortcut-badge">${escapeHtml(t("reader.keySpace"))}</span></button>`;
  }
  if (id === "youglish") {
    const title = escapeAttribute(t("reader.youglishWordTitle"));
    return `<button class="secondary-button" type="button" data-word-panel-item="youglish" data-youglish-word="${escapedDisplayWord}" title="${title}" aria-label="${title}">${icon("video", 18)}<span class="shortcut-badge">Y</span></button>`;
  }
  if (id === "copy") {
    return `<button class="secondary-button" type="button" data-word-panel-item="copy" data-copy-word="${escapedDisplayWord}" title="${label}" aria-label="${label}">${icon("copy", 18)}</button>`;
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
  hasVisibleSmartSuggestion: boolean,
  articleSuggestion: ArticleSmartSuggestion | null,
  isTransientRange: boolean
): string {
  if (id === "status") return renderStatusItem(word, entry);
  if (id === "article") return renderArticleEditor(entry, word, articleSuggestion, isTransientRange);
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
        <span class="row-between">
          ${escapeHtml(t("reader.noteLabel"))} <span class="shortcut-badge badge-tiny">N</span>
        </span>
        <textarea rows="4" spellcheck="false" data-word="${escapeAttribute(word)}" data-word-field="note" placeholder="${escapeAttribute(t("reader.notePlaceholder"))}">${escapeHtml(entry.note || "")}</textarea>
      </label>
    `;
  }
  if (id === "image") {
    return entry.imageUrl ? `
      <div class="word-image-preview upload-zone" data-word-panel-item="image">
        <img src="${escapeAttribute(entry.imageUrl)}" alt="${escapeAttribute(t("reader.imageAlt"))}"  class="thumb-bordered" />
        <button class="word-image-remove" type="button" data-action="remove-image" data-word="${escapeAttribute(word)}" aria-label="${escapeAttribute(t("reader.removeImage"))}" title="${escapeAttribute(t("reader.removeImage"))}">×</button>
      </div>
    ` : `
      <div class="word-image-search m-t-1-center" data-word-panel-item="image">
        <button class="secondary-button button-xs image-action-button" type="button" data-action="search-image" data-word="${escapeAttribute(word)}" title="${escapeAttribute(t("vocab.addImage"))}">
          ${icon("image", 14)}
          ${escapeHtml(t("vocab.addImage"))}
          <span class="shortcut-badge">I</span>
        </button>
        <div id="image-search-results-${escapeAttribute(word)}" class="m-t-025"></div>
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
  if (id === "ai") {
    return `
      <div class="word-panel-item" data-word-panel-item="ai">
        <button class="secondary-button button-xs ai-explain-button" type="button" data-ai-explain>
          ${icon("sparkles", 14)} ${escapeHtml(t("reader.aiExplain"))} <span class="shortcut-badge">Ctrl+E</span>
        </button>
        <p class="ai-explanation" data-ai-explanation role="status" aria-live="polite" hidden></p>
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
  hasVisibleSmartSuggestion: boolean,
  articleSuggestion: ArticleSmartSuggestion | null
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
    const content = renderContentItem(
      item.id,
      word,
      entry,
      context,
      smartSuggestionHtml,
      hasVisibleSmartSuggestion,
      articleSuggestion,
      isTransientRange
    );
    if (!content) continue;
    flushActions();
    parts.push(content);
  }
  flushActions();
  return parts.join("");
}

export function renderWordPanel(currentText: WhText): void {
  contextTranslationGeneration += 1;
  wordPanelRenderGeneration += 1;
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
    : state.vocab[word] || getOrCreateEntry(word);
  const displayWord = entry.word || word;
  applyWordPanelStatus(entry.status);
  resetInTextReview(word);
  const context = entry.examples?.[0] || "";

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
        <h2 class="word-title" data-headword-word="${escapeAttribute(word)}">${escapeHtml(formatHeadword(displayWord, entry.article))}</h2>
      </div>
      <button class="icon-button word-panel-close" type="button" data-close-word-panel aria-label="${escapeAttribute(t("reader.close"))}" title="${escapeAttribute(t("reader.close"))}">×</button>
    </div>
    <div class="word-form">
      ${renderConfiguredItems(word, entry, context, smartSuggestionHtml, isTransientRange, hasVisibleSmartSuggestion, articleSuggestion)}
    </div>
  `;
  bindInTextReviewControls(currentText, word, entry, hasVisibleSmartSuggestion);
  bindContextTranslation(word, context);
  bindAiExplain(word, context, isTransientRange);
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
    const language = effectiveLearningLanguage(state.preferences);
    const algorithm = state.preferences.wordDetectionAlgorithm || "modern";
    const session = analyzeReaderSession(
      getReaderSession(current, language, algorithm),
      state.vocab,
      language,
      getVocabularyRevision()
    );
    const stats = session.stats!;
    renderTrackingSummary(stats);
    if (els.uniqueSummary) {
      els.uniqueSummary.textContent = plural("reader.uniqueSummary", stats.unique, { n: stats.unique });
    }
  }
}
