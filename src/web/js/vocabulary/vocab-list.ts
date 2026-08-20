/**
 * Vocabulary list: rendering, filtering, load-more.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, statusLabel } from "../utils.js";
import { icon } from "../icons.js";
import { normalizeSearchVariants, normalizeVocabularyWord } from "../tokenizer_v2.js";
import { t } from "../i18n.js";
import { getTextVocabularyIndex, getVocabularyTextOptions, entryAppearsInText } from "../text-vocab.js";
import type { VocabularyTextOption } from "../text-vocab.js";
import { getAllBooks } from "../books.js";
import { isVocabStatus, VOCAB_STATUS_FILTERS } from "../events/vocab-status.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import { formatHeadword } from "./article.js";

type VocabListEntry = WhVocabEntry & { key: string; word: string };

export let vocabRenderCount = 50;
export let filteredVocabEntries: VocabListEntry[] = [];
export const sessionAddedWords = new Set<string>();

/**
 * Sorted base list cache: mapping + sorting (the expensive part of every
 * render) is skipped when neither the vocab reference nor the key count
 * changed since the last render. Explicit invalidation is called from every
 * updatedAt-touching mutation site (see invalidateVocabListCache callers).
 */
let cachedVocabBase: { source: WhVocabulary; keyCount: number; entries: VocabListEntry[] } | null = null;

export function invalidateVocabListCache(): void {
  cachedVocabBase = null;
}

/**
 * Cached text-filter <select> options (perf): the option list only depends on
 * the book catalog + custom texts (id + title), not on vocab, so rebuild the
 * <select> DOM only when that signature actually changes instead of on every
 * renderVocabulary pass.
 */
let cachedVocabTextSelect: { signature: string; options: VocabularyTextOption[]; html: string } | null = null;

function vocabTextSelectSignature(): string {
  const books = getAllBooks().map((book) => `${book.id}:${book.title}`).join("\u0001");
  const customs = (state.customTexts || []).map((text) => `${text.id || ""}:${text.title || ""}`).join("\u0001");
  return `${books}\u0002${customs}`;
}

function getVocabTextSelect(): { options: VocabularyTextOption[]; html: string } {
  const signature = vocabTextSelectSignature();
  if (cachedVocabTextSelect && cachedVocabTextSelect.signature === signature) {
    return cachedVocabTextSelect;
  }
  const options = getVocabularyTextOptions();
  const html = [
    `<option value="all">${escapeHtml(t("vocab.allTexts"))}</option>`,
    ...options.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(item.title)}</option>`)
  ].join("");
  cachedVocabTextSelect = { signature, options, html };
  return cachedVocabTextSelect;
}

function getVocabBase(): VocabListEntry[] {
  const source = state.vocab;
  if (cachedVocabBase
    && cachedVocabBase.source === source
    && cachedVocabBase.keyCount === Object.keys(source).length) {
    return cachedVocabBase.entries;
  }
  const entries = Object.entries(source)
    .map(([key, entry]): VocabListEntry => ({ ...entry, key, word: entry.word || key }))
    .sort((first, second) => (second.updatedAt || "").localeCompare(first.updatedAt || ""));
  cachedVocabBase = { source, keyCount: entries.length, entries };
  return entries;
}

function getSelectedVocabStatuses(): WhVocabStatus[] {
  if (!Array.isArray(state.filters.vocabStatuses)) {
    state.filters.vocabStatuses = VOCAB_STATUS_FILTERS.filter(isVocabStatus);
  }
  return state.filters.vocabStatuses.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
}

function syncVocabStatusCheckboxes(): void {
  if (!els.vocabStatusFilters?.length) return;
  const selected = new Set(getSelectedVocabStatuses());
  els.vocabStatusFilters.forEach((input) => {
    input.checked = isVocabStatus(input.value) && selected.has(input.value);
  });
}

function syncVocabTextFilter() {
  if (!els.vocabTextFilter) return null;
  const { options, html } = getVocabTextSelect();
  const ids = new Set(options.map((item) => item.id));
  if (state.filters.vocabTextId && state.filters.vocabTextId !== "all" && !ids.has(state.filters.vocabTextId)) {
    state.filters.vocabTextId = "all";
  }
  const selected = state.filters.vocabTextId || "all";
  if (els.vocabTextFilter.innerHTML !== html) {
    els.vocabTextFilter.innerHTML = html;
  }
  els.vocabTextFilter.value = selected;
  return selected === "all" ? null : getTextVocabularyIndex(selected);
}

function syncVocabExportButtons(): void {
  if (els.exportVocabTxt) els.exportVocabTxt.innerHTML = icon("fileText", 16);
  if (els.exportVocabAnki) els.exportVocabAnki.innerHTML = icon("cards", 16);
}

export function renderVocabulary(resetLimit = true): void {
  if (!els.vocabTableBody) return;
  els.vocabSearch.value = state.filters.vocabQuery || "";
  syncVocabExportButtons();
  syncVocabStatusCheckboxes();
  const textIndex = syncVocabTextFilter();
  const pocketMode = document.documentElement.classList.contains("pocket-mode");

  if (resetLimit) vocabRenderCount = 50;

  const queryVariants = normalizeSearchVariants(state.filters.vocabQuery || "");
  const vocabularyLanguage = effectiveLearningLanguage(state.preferences);
  const canonicalQuery = normalizeVocabularyWord(state.filters.vocabQuery || "", vocabularyLanguage);
  if (canonicalQuery && !queryVariants.includes(canonicalQuery)) queryVariants.push(canonicalQuery);
  const statusFilters = new Set(getSelectedVocabStatuses());
  filteredVocabEntries = getVocabBase()
    .filter((entry) => {
      const matchesStatus = statusFilters.has(entry.status);
      const haystackText = `${formatHeadword(entry.word, entry.article)} ${entry.word} ${normalizeVocabularyWord(entry.word, vocabularyLanguage)} ${entry.translation || ""} ${entry.note || ""}`;
      const haystacks = normalizeSearchVariants(haystackText);
      const matchesQuery = !state.filters.vocabQuery || queryVariants.some(q => haystacks.some(h => h.includes(q)));
      const matchesText = !textIndex || entryAppearsInText(
        entry.word,
        textIndex,
        vocabularyLanguage
      );
      return matchesStatus && matchesQuery && matchesText;
    });

  if (!filteredVocabEntries.length) {
    els.vocabTableBody.innerHTML = `<tr><td colspan="5" class="empty-row">${escapeHtml(t("vocab.empty"))}<button type="button" class="ghost-button empty-cta" data-open-view="discover">${escapeHtml(t("nav.discover"))}</button></td></tr>`;
    return;
  }

  const entriesToRender = filteredVocabEntries.slice(0, vocabRenderCount);

  els.vocabTableBody.innerHTML = entriesToRender.map((entry) => {
    const addedInSession = sessionAddedWords.has(entry.key);
    const translationField = pocketMode ? `
        <textarea
          class="vocab-translation-input${entry.translation ? "" : " empty"}"
          rows="2"
          data-word="${escapeAttribute(entry.key)}"
          data-word-field="translation"
          placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
          aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: entry.word }))}">${escapeHtml(entry.translation || "")}</textarea>
      ` : `
        <input
          class="vocab-translation-input${entry.translation ? "" : " empty"}"
          type="text"
          value="${escapeAttribute(entry.translation || "")}"
          data-word="${escapeAttribute(entry.key)}"
          data-word-field="translation"
          placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
          aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: entry.word }))}">
      `;
    return `
    <tr class="${addedInSession ? "vocab-row-added-in-session" : ""}">
      <td><strong>${escapeHtml(formatHeadword(entry.word, entry.article))}</strong></td>
      <td><span class="status-chip status-${escapeHtml(entry.status)}">${escapeHtml(statusLabel(entry.status))}</span></td>
      <td>
        ${translationField}
      </td>
      <td>${escapeHtml((entry.examples && entry.examples[0]) || entry.note || "")}</td>
      <td>
        <div class="row-actions">
          <button class="icon-button" type="button" data-edit-word="${escapeHtml(entry.key)}" title="${escapeAttribute(t("editBook.title"))}" aria-label="${escapeAttribute(t("editBook.title"))}">${icon("edit", 16)}</button>
          <button class="icon-button" type="button" data-tts-word="${escapeAttribute(formatHeadword(entry.word, entry.article))}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" aria-label="${escapeAttribute(t("reader.ttsWordTitle"))}">${icon("speaker", 16)}</button>
          <button class="icon-button" type="button" data-youglish-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}" aria-label="${escapeAttribute(t("reader.youglishWordTitle"))}">${icon("video", 16)}</button>
          <button class="icon-button status-blue" type="button" data-word="${escapeHtml(entry.key)}" data-set-status="learning" title="${escapeAttribute(t("vocab.btnLearning"))}" aria-label="${escapeAttribute(t("vocab.btnLearning"))}">${icon("pencil", 14)}</button>
          <button class="icon-button status-green" type="button" data-word="${escapeHtml(entry.key)}" data-set-status="known" title="${escapeAttribute(t("vocab.btnKnown"))}" aria-label="${escapeAttribute(t("vocab.btnKnown"))}">${icon("check", 14)}</button>
          <button class="icon-button status-muted" type="button" data-ignore-word="${escapeHtml(entry.key)}" title="${escapeAttribute(t("vocab.btnIgnore"))}" aria-label="${escapeAttribute(t("vocab.btnIgnore"))}">${icon("eyeOff", 14)}</button>
          <button class="icon-button danger-button" type="button" data-delete-word="${escapeHtml(entry.key)}" title="${escapeAttribute(t("vocab.btnDelete"))}" aria-label="${escapeAttribute(t("vocab.btnDelete"))}">${icon("trash", 14)}</button>
        </div>
      </td>
    </tr>
  `;
  }).join("");

  if (vocabRenderCount < filteredVocabEntries.length) {
    els.vocabTableBody.innerHTML += `<tr><td colspan="5" class="center-p-1"><button type="button" class="ghost-button" id="load-more-vocab">${escapeHtml(t("vocab.loadMore"))}</button></td></tr>`;
  }
}

export function loadMoreVocab(): void {
  vocabRenderCount += 50;
  renderVocabulary(false);
}
