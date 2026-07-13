import { state, saveState } from "../state.js";
import { t } from "../i18n.js";
import { statusIcon } from "../icons.js";
import { STATUS_ORDER, type VocabStatus } from "../constants.js";
import { statusLabel, escapeHtml, escapeAttribute } from "../utils.js";
import { getOrCreateEntry, renderVocabulary } from "../views/vocabulary.js";
import { setEntryStatus } from "../vocabulary/entry-state.js";
import { playStatusSound } from "../status-sounds.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";
import { VOCAB_STATUS_FILTERS } from "./vocab-status.js";

type AddWordOriginalValues = {
  word: string;
  translation: string;
  example: string;
  status: VocabStatus;
};

let addWordStatusButtons: HTMLButtonElement[] = [];

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
    const translation = addTranslationInput?.value || "";
    const example = addExampleInput?.value || "";
    const status = getAddWordStatus();
    return word !== addWordOriginalValues.word
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
    if (addWordInput) { addWordInput.value = word; addWordInput.disabled = true; }
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

  addWordConfirm.addEventListener("click", () => {
    const editing = addWordEditing?.value;
    const selectedStatus = getAddWordStatus();
    const now = new Date().toISOString();
    if (editing) {
      const entry = state.vocab[editing];
      if (!entry) return;
      const translation = addTranslationInput?.value.trim();
      if (translation !== undefined && translation !== entry.translation) {
        entry.translation = translation;
        delete entry.translationSource;
        if (translation) delete entry.translationAutoRejected;
        else entry.translationAutoRejected = true;
      }
      const previousStatus = setEntryStatus(entry, selectedStatus, now);
      if (previousStatus !== selectedStatus) playStatusSound(selectedStatus);
      const example = addExampleInput?.value.trim();
      if (example) {
        entry.examples = [example, ...(entry.examples || []).filter(e => e !== example)].slice(0, 3);
      } else {
        entry.examples = (entry.examples || []).slice(1);
      }
      entry.updatedAt = now;
    } else {
      const word = addWordInput?.value.trim();
      if (!word) return;
      const entry = getOrCreateEntry(word);
      const previousStatus = setEntryStatus(entry, selectedStatus, now);
      if (previousStatus !== selectedStatus) playStatusSound(selectedStatus);
      const translation = addTranslationInput?.value.trim();
      if (translation) entry.translation = translation;
      const example = addExampleInput?.value.trim();
      if (example && !entry.examples?.includes(example)) {
        entry.examples = [example, ...(entry.examples || [])].slice(0, 3);
      }
    }
    saveState();
    renderVocabulary();
    resetAddWordDirty();
    addWordDialog.close();
    if (editing && state.currentView === "reader") {
      import("../reader/renderer.js").then(({ renderReader }) => {
        if (state.currentView === "reader" && state.selectedWord === editing) renderReader();
      });
    }
  });

  addWordDialog.addEventListener("keydown", (e) => {
    if (e.target === addExampleInput && e.key === "Enter" && !e.ctrlKey && !e.metaKey) return;
    const statusShortcutMap: Record<string, VocabStatus> = { "1": "new", "2": "learning", "3": "known", "4": "ignored" };
    const statusDigit = statusShortcutMap[e.key]
      ? e.key
      : e.code?.match(/^(?:Digit|Numpad)([1-4])$/)?.[1];
    if (statusDigit && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target === addWordInput || e.target === addTranslationInput || e.target === addExampleInput) {
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
