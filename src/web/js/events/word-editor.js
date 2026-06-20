import { state, saveState } from "../state.js";
import { t } from "../i18n.js";
import { statusIcon } from "../icons.js";
import { STATUS_ORDER } from "../constants.js";
import { statusLabel, escapeHtml, escapeAttribute } from "../utils.js";
import { getOrCreateEntry, renderVocabulary } from "../views/vocabulary.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";
import { VOCAB_STATUS_FILTERS } from "./vocab-status.js";

let addWordStatusButtons = [];

function renderAddWordStatusButtons() {
  const container = document.getElementById("add-word-status-buttons");
  if (!container) return;
  const shortcutMap = { new: 1, learning: 2, known: 3, ignored: 4 };
  container.innerHTML = STATUS_ORDER.map((status) => `
    <button class="status-button status-${status}${status === "new" ? " active" : ""}" type="button" data-add-word-status="${status}" aria-pressed="${status === "new"}" title="${escapeAttribute(statusLabel(status))}">
      ${statusIcon(status, 14)} ${escapeHtml(statusLabel(status))} <span class="shortcut-badge">${shortcutMap[status]}</span>
    </button>
  `).join("");
  addWordStatusButtons = [...container.querySelectorAll("[data-add-word-status]")];
}

function getAddWordStatus() {
  const active = addWordStatusButtons.find(btn => btn.classList.contains("active"));
  return active?.dataset.addWordStatus || "new";
}

function setAddWordStatus(status) {
  const normalized = VOCAB_STATUS_FILTERS.includes(status) ? status : "new";
  addWordStatusButtons.forEach(btn => {
    const isActive = btn.dataset.addWordStatus === normalized;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

export function bindWordEditorEvents() {
  const addWordBtn = document.getElementById("add-word-btn");
  const addWordDialog = document.getElementById("add-word-dialog");
  const addWordInput = document.getElementById("add-word-input");
  const addTranslationInput = document.getElementById("add-translation-input");
  const addExampleInput = document.getElementById("add-example-input");
  const addWordConfirm = document.getElementById("add-word-confirm");
  const addWordCancel = document.getElementById("add-word-cancel");
  const addWordEditing = document.getElementById("add-word-editing");
  let addWordOriginalValues = null;

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
      const btn = e.target.closest("[data-add-word-status]");
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
    const editBtn = e.target.closest("[data-edit-word]");
    if (!editBtn || !addWordDialog) return;
    const word = editBtn.dataset.editWord;
    const entry = state.vocab[word];
    if (!entry) return;
    addWordEditing.value = word;
    if (addWordInput) { addWordInput.value = word; addWordInput.disabled = true; }
    if (addTranslationInput) addTranslationInput.value = entry.translation || "";
    if (addExampleInput) addExampleInput.value = (entry.examples && entry.examples[0]) || entry.note || "";
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
    if (editing) {
      const entry = state.vocab[editing];
      if (!entry) return;
      const translation = addTranslationInput?.value.trim();
      if (translation !== undefined) entry.translation = translation;
      entry.status = selectedStatus;
      const example = addExampleInput?.value.trim();
      if (example) {
        entry.examples = [example, ...(entry.examples || []).filter(e => e !== example)].slice(0, 3);
      } else {
        entry.examples = entry.examples || [];
      }
      entry.updatedAt = new Date().toISOString();
    } else {
      const word = addWordInput?.value.trim();
      if (!word) return;
      getOrCreateEntry(word);
      state.vocab[word].status = selectedStatus;
      const translation = addTranslationInput?.value.trim();
      if (translation) {
        state.vocab[word].translation = translation;
      }
      const example = addExampleInput?.value.trim();
      if (example && !state.vocab[word].examples?.includes(example)) {
        state.vocab[word].examples = [example, ...(state.vocab[word].examples || [])].slice(0, 3);
      }
    }
    saveState();
    renderVocabulary();
    resetAddWordDirty();
    addWordDialog.close();
  });

  addWordDialog.addEventListener("keydown", (e) => {
    if (e.target === addExampleInput && e.key === "Enter" && !e.ctrlKey && !e.metaKey) return;
    const statusShortcutMap = { "1": "new", "2": "learning", "3": "known", "4": "ignored" };
    if (statusShortcutMap[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.target === addWordInput || e.target === addTranslationInput || e.target === addExampleInput) {
        e.preventDefault();
        setAddWordStatus(statusShortcutMap[e.key]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addWordConfirm.click();
    }
  });
}
