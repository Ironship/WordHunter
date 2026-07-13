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
}
