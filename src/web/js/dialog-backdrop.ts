// Shared dialog backdrop click handler with unsaved-changes guard.
import { t } from "./i18n.js";

type DialogAction = () => unknown;

function buildConfirmDialog(): HTMLDialogElement {
  const existing = document.getElementById("unsaved-confirm-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#unsaved-confirm-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "unsaved-confirm-dialog";
  dialog.className = "panel";
  dialog.style.width = "90vw";
  dialog.style.maxWidth = "420px";

  const title = document.createElement("div");
  title.className = "panel-header";
  const h2 = document.createElement("h2");
  h2.dataset.i18n = "unsavedChanges.title";
  h2.textContent = t("unsavedChanges.title");
  title.appendChild(h2);

  const body = document.createElement("div");
  body.className = "settings-body";
  body.style.padding = "1.5rem";
  body.style.gap = "1rem";

  const msg = document.createElement("p");
  msg.className = "muted-copy";
  msg.style.margin = "0";
  msg.dataset.i18n = "unsavedChanges.message";
  msg.textContent = t("unsavedChanges.message");

  const btns = document.createElement("div");
  btns.style.display = "flex";
  btns.style.gap = "0.5rem";
  btns.style.justifyContent = "flex-end";
  btns.style.marginTop = "1rem";

  const btnCancel = document.createElement("button");
  btnCancel.className = "secondary-button";
  btnCancel.dataset.i18n = "unsavedChanges.cancel";
  btnCancel.textContent = t("unsavedChanges.cancel");

  const btnDiscard = document.createElement("button");
  btnDiscard.className = "secondary-button";
  btnDiscard.dataset.i18n = "unsavedChanges.discard";
  btnDiscard.textContent = t("unsavedChanges.discard");

  const btnSave = document.createElement("button");
  btnSave.className = "primary-button";
  btnSave.dataset.i18n = "unsavedChanges.save";
  btnSave.textContent = t("unsavedChanges.save");

  btns.appendChild(btnCancel);
  btns.appendChild(btnDiscard);
  btns.appendChild(btnSave);
  body.appendChild(msg);
  body.appendChild(btns);

  dialog.appendChild(title);
  dialog.appendChild(body);
  document.body.appendChild(dialog);

  return dialog;
}

function showUnsavedConfirm(onSave?: DialogAction, onDiscard?: DialogAction): void {
  const dialog = buildConfirmDialog();
  const btns = dialog.querySelectorAll("button");
  const btnCancel = btns[0];
  const btnDiscard = btns[1];
  const btnSave = btns[2];

  const cleanup = () => {
    dialog.removeEventListener("cancel", handleDialogCancel);
    btnCancel.removeEventListener("click", handleCancel);
    btnDiscard.removeEventListener("click", handleDiscard);
    btnSave.removeEventListener("click", handleSave);
    dialog.close();
  };

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation();
    cleanup();
  };
  const handleDiscard = (e: MouseEvent) => {
    e.stopPropagation();
    cleanup();
    if (onDiscard) onDiscard();
  };
  const handleSave = (e: MouseEvent) => {
    e.stopPropagation();
    cleanup();
    if (onSave) onSave();
  };
  const handleDialogCancel = (e: Event) => {
    e.preventDefault();
    cleanup();
  };

  dialog.addEventListener("cancel", handleDialogCancel);
  btnCancel.addEventListener("click", handleCancel);
  btnDiscard.addEventListener("click", handleDiscard);
  btnSave.addEventListener("click", handleSave);

  dialog.showModal();
}

export function registerUnsavedDialog(
  dialogId: string,
  checkDirty: () => boolean,
  onSave?: DialogAction,
  onDiscard?: DialogAction
): void {
  const dialog = document.getElementById(dialogId);
  if (!(dialog instanceof HTMLDialogElement)) return;

  const discard = () => {
    if (onDiscard) {
      onDiscard();
    } else {
      dialog.close();
    }
  };

  const requestClose = () => {
    if (!checkDirty()) {
      discard();
      return;
    }
    showUnsavedConfirm(onSave, discard);
  };

  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    e.preventDefault();
    e.stopPropagation();
    requestClose();
  });

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    requestClose();
  });
}
