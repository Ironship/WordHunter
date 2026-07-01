import { state } from "../state.js";
import { t } from "../i18n.js";
import { moveBookToProfile } from "../book-actions.js";
import { LEARNING_LANGUAGES } from "../constants.js";

const MOVE_BOOK_LANGS = LEARNING_LANGUAGES;

export function bindMoveBookEvents() {
  let moveBookTarget = null;
  let moveBookIsCustom = false;

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='move-book']");
    if (!btn) return;
    moveBookTarget = btn.dataset.id;
    moveBookIsCustom = btn.dataset.iscustom === "true";
    const dialog = document.getElementById("move-book-dialog");
    const select = document.getElementById("move-book-select");
    select.innerHTML = MOVE_BOOK_LANGS
      .filter((code) => code !== state.preferences.learningLanguage)
      .map((code) => `<option value="${code}">${t(`languages.${code}`)}</option>`)
      .join("");
    dialog.showModal();
  });

  const moveCancelBtn = document.getElementById("move-book-cancel");
  if (moveCancelBtn) moveCancelBtn.addEventListener("click", () => document.getElementById("move-book-dialog").close());

  const moveConfirmBtn = document.getElementById("move-book-confirm");
  if (!moveConfirmBtn) return;

  moveConfirmBtn.addEventListener("click", () => {
    const select = document.getElementById("move-book-select");
    if (select.value && moveBookTarget) moveBookToProfile(moveBookTarget, select.value, moveBookIsCustom);
    document.getElementById("move-book-dialog").close();
  });

  const moveSelect = document.getElementById("move-book-select");
  if (moveSelect) {
    moveSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        moveConfirmBtn.click();
      }
    });
  }
}
