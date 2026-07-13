/**
 * Vocabulary list: rendering, filtering, load-more.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, statusLabel } from "../utils.js";
import { icon } from "../icons.js";
import { normalizeSearchVariants } from "../tokenizer_v2.js";
import { t } from "../i18n.js";
import { getTextVocabularyIndex, getVocabularyTextOptions, entryAppearsInText } from "../text-vocab.js";
import { isVocabStatus, VOCAB_STATUS_FILTERS } from "../events/vocab-status.js";

type VocabListEntry = WhVocabEntry & { word: string };

export let vocabRenderCount = 50;
export let filteredVocabEntries: VocabListEntry[] = [];
export const sessionAddedWords = new Set<string>();

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
  const options = getVocabularyTextOptions();
  const ids = new Set(options.map((item) => item.id));
  if (state.filters.vocabTextId && state.filters.vocabTextId !== "all" && !ids.has(state.filters.vocabTextId)) {
    state.filters.vocabTextId = "all";
  }
  const selected = state.filters.vocabTextId || "all";
  els.vocabTextFilter.innerHTML = [
    `<option value="all">${escapeHtml(t("vocab.allTexts"))}</option>`,
    ...options.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(item.title)}</option>`)
  ].join("");
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
  const statusFilters = new Set(getSelectedVocabStatuses());
  filteredVocabEntries = Object.entries(state.vocab)
    .map(([word, entry]): VocabListEntry => ({ word, ...entry }))
    .filter((entry) => {
      const matchesStatus = statusFilters.has(entry.status);
      const haystackText = `${entry.word} ${entry.translation || ""} ${entry.note || ""}`;
      const haystacks = normalizeSearchVariants(haystackText);
      const matchesQuery = !state.filters.vocabQuery || queryVariants.some(q => haystacks.some(h => h.includes(q)));
      const matchesText = !textIndex || entryAppearsInText(entry.word, textIndex);
      return matchesStatus && matchesQuery && matchesText;
    })
    .sort((first, second) => (second.updatedAt || "").localeCompare(first.updatedAt || ""));

  if (!filteredVocabEntries.length) {
    els.vocabTableBody.innerHTML = `<tr><td colspan="5" class="empty-row">${escapeHtml(t("vocab.empty"))}</td></tr>`;
    return;
  }

  const entriesToRender = filteredVocabEntries.slice(0, vocabRenderCount);

  els.vocabTableBody.innerHTML = entriesToRender.map((entry) => {
    const addedInSession = sessionAddedWords.has(entry.word);
    const translationField = pocketMode ? `
        <textarea
          class="vocab-translation-input${entry.translation ? "" : " empty"}"
          rows="2"
          data-word="${escapeAttribute(entry.word)}"
          data-word-field="translation"
          placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
          aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: entry.word }))}">${escapeHtml(entry.translation || "")}</textarea>
      ` : `
        <input
          class="vocab-translation-input${entry.translation ? "" : " empty"}"
          type="text"
          value="${escapeAttribute(entry.translation || "")}"
          data-word="${escapeAttribute(entry.word)}"
          data-word-field="translation"
          placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
          aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: entry.word }))}">
      `;
    return `
    <tr class="${addedInSession ? "vocab-row-added-in-session" : ""}">
      <td><strong>${escapeHtml(entry.word)}</strong></td>
      <td><span class="status-chip status-${escapeHtml(entry.status)}">${escapeHtml(statusLabel(entry.status))}</span></td>
      <td>
        ${translationField}
      </td>
      <td>${escapeHtml((entry.examples && entry.examples[0]) || entry.note || "")}</td>
      <td>
        <div class="row-actions">
          <button class="icon-button" type="button" data-edit-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("editBook.title"))}">${icon("edit", 16)}</button>
          <button class="icon-button" type="button" data-tts-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}">${icon("speaker", 16)}</button>
          <button class="icon-button" type="button" data-youglish-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}">${icon("video", 16)}</button>
          <button class="icon-button" style="color: var(--blue); border-color: color-mix(in srgb, var(--blue) 42%, var(--line)); background: var(--blue-soft);" type="button" data-word="${escapeHtml(entry.word)}" data-set-status="learning" title="${escapeAttribute(t("vocab.btnLearning"))}">${icon("pencil", 14)}</button>
          <button class="icon-button" style="color: var(--green); border-color: color-mix(in srgb, var(--green) 42%, var(--line)); background: var(--green-soft);" type="button" data-word="${escapeHtml(entry.word)}" data-set-status="known" title="${escapeAttribute(t("vocab.btnKnown"))}">${icon("check", 14)}</button>
          <button class="icon-button" style="color: var(--muted); border-color: var(--line);" type="button" data-ignore-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("vocab.btnIgnore"))}">${icon("eyeOff", 14)}</button>
          <button class="icon-button danger-button" type="button" data-delete-word="${escapeHtml(entry.word)}" title="${escapeAttribute(t("vocab.btnDelete"))}">${icon("trash", 14)}</button>
        </div>
      </td>
    </tr>
  `;
  }).join("");

  if (vocabRenderCount < filteredVocabEntries.length) {
    els.vocabTableBody.innerHTML += `<tr><td colspan="5" style="text-align: center; padding: 1rem;"><button type="button" class="ghost-button" id="load-more-vocab">${escapeHtml(t("vocab.loadMore"))}</button></td></tr>`;
  }
}

export function loadMoreVocab(): void {
  vocabRenderCount += 50;
  renderVocabulary(false);
}
