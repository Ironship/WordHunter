import { state, saveState } from "../state.js";
import { withElementBusy } from "../loading.js";
import { t } from "../i18n.js";
import { showToast } from "../toast.js";
import { statusIcon } from "../icons.js";
import { STATUS_ORDER, type VocabStatus } from "../constants.js";
import { statusLabel, escapeHtml, escapeAttribute } from "../utils.js";
import { invalidateVocabListCache } from "../vocabulary/vocab-list.js";
import { getOrCreateEntry, renderVocabulary } from "../views/vocabulary.js";
import { setEntryStatus } from "../vocabulary/entry-state.js";
import { playStatusSound } from "../status-sounds.js";
import { invalidateReviewQueueCache } from "../vocabulary/review-card.js";
import { invalidateSuggestIndex } from "../reader/smart-suggest.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";
import { VOCAB_STATUS_FILTERS } from "./vocab-status.js";
import { resolveVocabularyKey } from "../tokenizer_v2.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";

type AddWordOriginalValues = {
  word: string;
  article: string;
  translation: string;
  example: string;
  status: VocabStatus;
};

/**
 * Builds the add/edit-word dialog markup once (idempotent). Called during
 * app boot before cacheElements() (app.ts); bindWordEditorEvents() resolves
 * the elements via querySelector, so boot order guarantees they exist.
 */
export function renderAddWordDialog(): HTMLDialogElement {
  const existing = document.getElementById("add-word-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#add-word-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "add-word-dialog";
  dialog.className = "panel word-editor-dialog dialog-680";
  dialog.setAttribute("aria-labelledby", "add-word-dialog-title");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 id="add-word-dialog-title" data-i18n="vocab.addWordTitle">Add word</h2>
    </div>
    <div class="word-editor-body">
      <div class="word-editor-grid">
        <label class="word-editor-field word-editor-word">
          <span data-i18n="vocab.addWordLabel">Word</span>
          <input id="add-word-input" type="text" class="input" autocomplete="off" autofocus>
        </label>
        <label class="word-editor-field word-editor-article">
          <span data-i18n="vocab.addArticleLabel">Article (optional)</span>
          <input id="add-article-input" type="text" class="input" autocomplete="off" spellcheck="false">
        </label>
        <label class="word-editor-field word-editor-translation">
          <span data-i18n="vocab.addTranslationLabel">Translation (optional)</span>
          <input id="add-translation-input" type="text" class="input" autocomplete="off">
        </label>
        <fieldset class="word-editor-status">
          <legend data-i18n="vocab.status">Status</legend>
          <div id="add-word-status-buttons" class="status-options"></div>
        </fieldset>
        <label class="word-editor-field word-editor-example">
          <span data-i18n="vocab.addExampleLabel">Example sentence (optional)</span>
          <textarea id="add-example-input" class="input" rows="4" autocomplete="off" spellcheck="false"></textarea>
        </label>
      </div>
      <div class="word-editor-actions">
        <button id="add-word-cancel" class="secondary-button" data-i18n="moveBook.cancel">Cancel</button>
        <button id="add-word-confirm" class="primary-button" data-i18n="vocab.addWordConfirm">Add</button>
      </div>
    </div>
    <input id="add-word-editing" type="hidden" value="">
  `;
  document.body.appendChild(dialog);
  return dialog;
}

let addWordStatusButtons: HTMLButtonElement[] = [];

/**
 * Re-localizes the add/edit-word dialog after the locale changes (post-boot
 * bridge snapshot #275, or a settings switch). The dialog's static labels
 * carry data-i18n and are refreshed by applyTranslations(), but the status
 * buttons are rendered once at bind time with statusLabel(...) — inside the
 * escaped template, not as data-i18n — so they must be rebuilt here to pick
 * up the new locale (#274). The currently active status survives the rebuild.
 */
export function refreshAddWordDialogLocalization(): void {
  const activeStatus = addWordStatusButtons
    .find((btn) => btn.classList.contains("active"))
    ?.dataset.addWordStatus;
  renderAddWordStatusButtons();
  if (activeStatus) setAddWordStatus(activeStatus);
}

function renderAddWordStatusButtons() {
  const container = document.getElementById("add-word-status-buttons");
  if (!container) return;
  const shortcutMap: Record<VocabStatus, number> = { new: 1, learning: 2, known: 3, ignored: 4 };
  container.innerHTML = STATUS_ORDER.map((status) => `
    <button class="status-button status-${status}${status === "new" ? " active" : ""}" type="button" data-add-word-status="${status}" aria-pressed="${status === "new"}" title="${escapeAttribute(statusLabel(status))}">
      ${statusIcon(status, 14)} ${escapeHtml(statusLabel(status))} <span class="shortcut-badge">${shortcutMap[status]}</span>
    </button>
  `).join("");
  addWordStatusButtons = [...container.querySelectorAll<HTMLButtonElement>("[data-add-word-status]")];
}

function getAddWordStatus(): VocabStatus {
  const active = addWordStatusButtons.find(btn => btn.classList.contains("active"));
  const status = active?.dataset.addWordStatus;
  return VOCAB_STATUS_FILTERS.includes(status) ? status as VocabStatus : "new";
}

function setAddWordStatus(status: unknown): void {
  const normalized: VocabStatus = typeof status === "string" && VOCAB_STATUS_FILTERS.includes(status)
    ? status as VocabStatus
    : "new";
  addWordStatusButtons.forEach(btn => {
    const isActive = btn.dataset.addWordStatus === normalized;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

export function bindWordEditorEvents() {
  const addWordBtn = document.querySelector<HTMLButtonElement>("#add-word-btn");
  const addWordDialog = document.querySelector<HTMLDialogElement>("#add-word-dialog");
  const addWordInput = document.querySelector<HTMLInputElement>("#add-word-input");
  const addArticleInput = document.querySelector<HTMLInputElement>("#add-article-input");
  const addTranslationInput = document.querySelector<HTMLInputElement>("#add-translation-input");
  const addExampleInput = document.querySelector<HTMLTextAreaElement>("#add-example-input");
  const addWordConfirm = document.querySelector<HTMLButtonElement>("#add-word-confirm");
  const addWordCancel = document.querySelector<HTMLButtonElement>("#add-word-cancel");
  const addWordEditing = document.querySelector<HTMLInputElement>("#add-word-editing");
  let addWordOriginalValues: AddWordOriginalValues | null = null;

  renderAddWordStatusButtons();

  function isAddWordDirty() {
    if (!addWordOriginalValues) return false;
    const word = addWordInput?.value || "";
    const article = addArticleInput?.value || "";
    const translation = addTranslationInput?.value || "";
    const example = addExampleInput?.value || "";
    const status = getAddWordStatus();
    return word !== addWordOriginalValues.word
      || article !== addWordOriginalValues.article
      || translation !== addWordOriginalValues.translation
      || example !== addWordOriginalValues.example
      || status !== addWordOriginalValues.status;
  }

  function resetAddWordDirty() {
    addWordOriginalValues = null;
  }

  function captureAddWordOriginal() {
    addWordOriginalValues = {
      word: addWordInput?.value || "",
      article: addArticleInput?.value || "",
      translation: addTranslationInput?.value || "",
      example: addExampleInput?.value || "",
      status: getAddWordStatus()
    };
  }

  registerUnsavedDialog(
    "add-word-dialog",
    isAddWordDirty,
    () => addWordConfirm.click(),
    () => { resetAddWordDirty(); addWordDialog.close(); }
  );

  if (addWordDialog) {
    addWordDialog.addEventListener("click", (e) => {
      const btn = e.target instanceof Element
        ? e.target.closest<HTMLButtonElement>("[data-add-word-status]")
        : null;
      if (!btn) return;
      e.preventDefault();
      setAddWordStatus(btn.dataset.addWordStatus);
    });
  }

  if (addWordBtn && addWordDialog) {
    addWordBtn.addEventListener("click", () => {
      addWordEditing.value = "";
      if (addWordInput) { addWordInput.value = ""; addWordInput.disabled = false; }
      if (addArticleInput) addArticleInput.value = "";
      if (addTranslationInput) addTranslationInput.value = "";
      if (addExampleInput) addExampleInput.value = "";
      setAddWordStatus("new");
      const title = addWordDialog.querySelector("#add-word-dialog-title");
      if (title) title.textContent = t("vocab.addWordTitle");
      addWordConfirm.textContent = t("vocab.addWordConfirm");
      captureAddWordOriginal();
      addWordDialog.showModal();
      if (addWordInput) setTimeout(() => addWordInput.focus(), 100);
    });
  }

  document.addEventListener("click", (e) => {
    const editBtn = e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-edit-word]")
      : null;
    if (!editBtn || !addWordDialog) return;
    const word = editBtn.dataset.editWord;
    const entry = state.vocab[word];
    if (!entry) return;
    addWordEditing.value = word;
    // rc.6: the headword itself is editable now — confirming with a changed
    // word renames the entry key (guarded against collisions, see below).
    if (addWordInput) { addWordInput.value = entry.word || word; addWordInput.disabled = false; }
    if (addArticleInput) addArticleInput.value = entry.article || "";
    if (addTranslationInput) addTranslationInput.value = entry.translation || "";
    if (addExampleInput) addExampleInput.value = entry.examples?.[0] || "";
    setAddWordStatus(entry.status || "new");
    const title = addWordDialog.querySelector("#add-word-dialog-title");
    if (title) title.textContent = t("vocab.editWordTitle");
    addWordConfirm.textContent = t("vocab.editWordConfirm");
    captureAddWordOriginal();
    addWordDialog.showModal();
    if (addTranslationInput) setTimeout(() => addTranslationInput.focus(), 100);
  });

  if (addWordCancel && addWordDialog) {
    addWordCancel.addEventListener("click", () => {
      resetAddWordDirty();
      addWordDialog.close();
    });
  }

  if (!addWordConfirm || !addWordDialog) return;

  // Busy spinner on the confirm button for the whole save+render — the same
  // indicator pattern as every other save/edit control in the app.
  addWordConfirm.addEventListener("click", () => {
    void withElementBusy(addWordConfirm, async () => {
    const editing = addWordEditing?.value;
    const selectedStatus = getAddWordStatus();
    const now = new Date().toISOString();
    if (editing) {
      const entry = state.vocab[editing];
      if (!entry) return;
      // rc.6: headword rename. The vocab map is keyed by the resolved token
      // key, so a changed word moves the SAME entry object under the new key
      // (SRS dates, note, examples survive). Colliding with an existing
      // different entry is rejected instead of silently merging.
      const newWord = addWordInput?.value.trim() || "";
      if (!newWord) {
        showToast(t("vocab.wordRequired"), "error");
        return;
      }
      const newKey = resolveVocabularyKey(newWord, state.vocab, effectiveLearningLanguage(state.preferences));
      if (newKey !== editing && state.vocab[newKey]) {
        showToast(t("vocab.wordExists"), "error");
        return;
      }
      const article = addArticleInput?.value.trim() || "";
      if (article) entry.article = article;
      else delete entry.article;
      const translation = addTranslationInput?.value.trim();
      if (translation !== undefined && translation !== entry.translation) {
        entry.translation = translation;
        delete entry.translationSource;
        if (translation) delete entry.translationAutoRejected;
        else entry.translationAutoRejected = true;
      }
      const previousStatus = setEntryStatus(entry, selectedStatus, now);
      if (previousStatus !== selectedStatus) playStatusSound(selectedStatus);
      // Dialog status edits bypass gradeReview/removeFromSrs — the queue memo
      // and the suggest index must not survive them.
      invalidateReviewQueueCache();
      invalidateSuggestIndex();
      const example = addExampleInput?.value.trim();
      if (example) {
        entry.examples = [example, ...(entry.examples || []).filter(e => e !== example)].slice(0, 3);
      } else {
        entry.examples = (entry.examples || []).slice(1);
      }
      let renamedTo: string | null = null;
      if (newKey !== editing) {
        delete state.vocab[editing];
        state.vocab[newKey] = entry;
        renamedTo = newKey;
      }
      entry.word = newWord;
      entry.updatedAt = now;
      // Keep the reader word panel on the same entry after a rename.
      if (renamedTo && state.selectedWord === editing) state.selectedWord = renamedTo;
      invalidateVocabListCache();
    } else {
      const word = addWordInput?.value.trim();
      if (!word) {
        showToast(t("vocab.wordRequired"), "error");
        return;
      }
      const entry = getOrCreateEntry(word);
      const previousStatus = setEntryStatus(entry, selectedStatus, now);
      if (previousStatus !== selectedStatus) playStatusSound(selectedStatus);
      // The add branch also feeds the review queue (status + nextDate are
      // memo inputs) — invalidate like the edit branch above.
      invalidateReviewQueueCache();
      invalidateSuggestIndex();
      const article = addArticleInput?.value.trim();
      if (article) entry.article = article;
      const translation = addTranslationInput?.value.trim();
      if (translation) entry.translation = translation;
      const example = addExampleInput?.value.trim();
      if (example && !entry.examples?.includes(example)) {
        entry.examples = [example, ...(entry.examples || [])].slice(0, 3);
      }
    }
    await saveState();
    renderVocabulary();
    resetAddWordDirty();
    addWordDialog.close();
    if (editing && state.currentView === "reader") {
      import("../reader/renderer.js").then(({ renderReader }) => {
        // After a rename the selection moved to the new key; refresh when it
        // points at either form (old key pre-rename, new key post-rename).
        if (state.currentView === "reader" && (state.selectedWord === editing || state.selectedWord === addWordInput?.value.trim())) renderReader();
      });
    }
    });
  });

  addWordDialog.addEventListener("keydown", (e) => {
    if (e.target === addExampleInput && e.key === "Enter" && !e.ctrlKey && !e.metaKey) return;
    const statusShortcutMap: Record<string, VocabStatus> = { "1": "new", "2": "learning", "3": "known", "4": "ignored" };
    const statusDigit = statusShortcutMap[e.key]
      ? e.key
      : e.code?.match(/^(?:Digit|Numpad)([1-4])$/)?.[1];
    if (statusDigit && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target === addWordInput || e.target === addArticleInput || e.target === addTranslationInput || e.target === addExampleInput) {
        e.preventDefault();
        setAddWordStatus(statusShortcutMap[statusDigit]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addWordConfirm.click();
    }
  });
}
