import { state } from "../state.js";
import { t } from "../i18n.js";
import { moveBookToProfile } from "../book-actions.js";
import { LEARNING_LANGUAGES } from "../constants.js";

const MOVE_BOOK_LANGS = LEARNING_LANGUAGES;

export function bindMoveBookEvents() {
  let moveBookTarget: string | null = null;
  let moveBookIsCustom = false;
  const dialog = document.querySelector<HTMLDialogElement>("#move-book-dialog");
  const select = document.querySelector<HTMLSelectElement>("#move-book-select");
  const moveCancelBtn = document.querySelector<HTMLButtonElement>("#move-book-cancel");
  const moveConfirmBtn = document.querySelector<HTMLButtonElement>("#move-book-confirm");
  let moveRunning = false;

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element
      ? e.target.closest<HTMLElement>("[data-action='move-book']")
      : null;
    if (!btn || !dialog || !select) return;
    moveBookTarget = btn.dataset.id;
    moveBookIsCustom = btn.dataset.iscustom === "true";
    select.innerHTML = MOVE_BOOK_LANGS
      .filter((code) => code !== state.preferences.learningLanguage)
      .map((code) => `<option value="${code}">${t(`languages.${code}`)}</option>`)
      .join("");
    dialog.showModal();
  });

  if (moveCancelBtn && dialog) moveCancelBtn.addEventListener("click", () => {
    if (!moveRunning) dialog.close();
  });

  if (!moveConfirmBtn || !select || !dialog) return;

  moveConfirmBtn.addEventListener("click", async () => {
    if (select.value && moveBookTarget) {
      moveRunning = true;
      moveConfirmBtn.disabled = true;
      if (moveCancelBtn) moveCancelBtn.disabled = true;
      select.disabled = true;
      try {
        if (await moveBookToProfile(moveBookTarget, select.value, moveBookIsCustom)) {
          dialog.close();
        }
      } finally {
        moveRunning = false;
        moveConfirmBtn.disabled = false;
        if (moveCancelBtn) moveCancelBtn.disabled = false;
        select.disabled = false;
      }
    }
  });

  select.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        moveConfirmBtn.click();
      }
  });

  dialog.addEventListener("cancel", (event) => {
    if (moveRunning) event.preventDefault();
  });

  // Close on backdrop click, consistent with the other dialogs.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !moveRunning) dialog.close();
  });
}

/**
 * Builds the move-book dialog markup once (idempotent). Called during app
 * boot before cacheElements() so every consumer finds the elements in the
 * DOM; data-i18n / data-i18n-attr attributes are applied by the boot-time
 * applyTranslations() pass (see app.ts).
 */
export function renderMoveBookDialog(): HTMLDialogElement {
  const existing = document.getElementById("move-book-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#move-book-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "move-book-dialog";
  dialog.className = "panel";
  dialog.setAttribute("aria-labelledby", "move-book-title");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 id="move-book-title" data-i18n="moveBook.title">Move Book</h2>
    </div>
    <div class="settings-body p-15-g-1">
      <p class="muted-copy" data-i18n="moveBook.hint">Select the target language profile for this book:</p>
      <select id="move-book-select" class="input" data-i18n-attr="aria-label=library.moveBook"></select>
      <div class="justify-end-m-t-1">
        <button id="move-book-cancel" class="secondary-button" data-i18n="moveBook.cancel">Cancel</button>
        <button id="move-book-confirm" class="primary-button" data-i18n="moveBook.confirm">Move</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}
