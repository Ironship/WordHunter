// Data & backup settings section (former monolithic events/settings.ts):
// store-bridge snapshot application, transfer/Anki import-export buttons,
// data-directory switching, update checks, destructive resets.
import { applyBridgeSnapshotToState, flushAllPendingFrontendState, getDurableStateRevision, runExclusiveStateWrite, state } from "../../state.js";
import { els } from "../../dom.js";
import { t } from "../../i18n.js";
import { render } from "../../render.js";
import { renderLibrary } from "../../views/library.js";
import { getTextById, renderReader } from "../../reader/renderer.js";
import { renderWordPanel } from "../../reader/word-panel.js";
import { syncSettingsControls, updatePreferenceValue, resetPreferences } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { clearWords, clearLibrary, exportAnkiTsv, importAnkiTsv, exportTransfer, importTransfer } from "../../sync-actions.js";
import { acknowledgeBackendSnapshot } from "../../store-bridge.js";
import { httpPost } from "../../http.js";
import { showConfirmDialog } from "../../dialog-backdrop.js";
import { setElementBusy } from "../../loading.js";
import { isAndroidPlatform } from "../../platform.js";
import { remapReaderBookmarksForAlgorithm } from "../../reader/bookmarks.js";
import { byId, beginWordAlgorithmChange, currentWordAlgorithmChangeGeneration } from "./shared.js";

type ApplyBridgeSnapshotOptions = {
  expectedRevision?: number;
  preserveActiveReader?: boolean;
};

export function applyBridgeSnapshot(
  snapshot: unknown,
  {
    expectedRevision,
    preserveActiveReader = false
  }: ApplyBridgeSnapshotOptions = {}
): boolean {
  if (!applyBridgeSnapshotToState(snapshot, { expectedRevision, preserveActiveReader })) return false;
  syncSettingsControls();
  if (preserveActiveReader && state.currentView === "reader") {
    const current = getTextById(state.currentTextId);
    if (current && state.selectedWord && els.wordPanel) renderWordPanel(current);
  } else {
    render();
  }
  return true;
}

async function applyLoadedSnapshot(snapshot: WhBridgeSnapshot, startingRevision: number): Promise<boolean> {
  return runExclusiveStateWrite(async () => {
    if (!applyBridgeSnapshot(snapshot, { expectedRevision: startingRevision })) return false;
    await acknowledgeBackendSnapshot(snapshot);
    return true;
  });
}

function confirmDataFolderChange(): Promise<boolean> {
  const message = t("settings.dataFolderConfirm");
  if (typeof HTMLDialogElement === "undefined") return Promise.resolve(window.confirm(message));

  let dialog = document.querySelector<HTMLDialogElement>("#data-folder-confirm-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "data-folder-confirm-dialog";
    dialog.className = "panel confirmation-dialog";
    dialog.innerHTML = `
      <div class="panel-header"><h2></h2></div>
      <div class="confirmation-dialog-body">
        <div class="confirmation-dialog-copy"></div>
        <div class="confirmation-dialog-actions">
          <button type="button" class="secondary-button" data-action="cancel"></button>
          <button type="button" class="primary-button" data-action="confirm">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
  }

  const parts = message.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) parts.pop();
  dialog.querySelector<HTMLElement>("h2").textContent = parts.shift() || t("settings.chooseDataFolder");
  const copy = dialog.querySelector<HTMLElement>(".confirmation-dialog-copy");
  copy.replaceChildren(...parts.map((part) => {
    const paragraph = document.createElement("p");
    paragraph.className = "muted-copy";
    paragraph.textContent = part;
    return paragraph;
  }));
  dialog.querySelector<HTMLButtonElement>('[data-action="cancel"]').textContent = t("moveBook.cancel");
  dialog.querySelector<HTMLButtonElement>('[data-action="confirm"]').textContent = t("onboarding.continue");

  return new Promise<boolean>((resolve) => {
    const cancelButton = dialog.querySelector<HTMLButtonElement>('[data-action="cancel"]');
    const confirmButton = dialog.querySelector<HTMLButtonElement>('[data-action="confirm"]');
    const cleanup = (value: boolean) => {
      cancelButton.removeEventListener("click", onCancel);
      confirmButton.removeEventListener("click", onConfirm);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      dialog.close();
      resolve(value);
    };
    const onCancel = (event: Event) => {
      event.preventDefault();
      cleanup(false);
    };
    const onConfirm = () => cleanup(true);
    const onBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) cleanup(false);
    };

    cancelButton.addEventListener("click", onCancel);
    confirmButton.addEventListener("click", onConfirm);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onBackdrop);
    dialog.showModal();
  });
}

export function bindDataSettings() {
  for (const [id, scope] of [["export-transfer-all", "all"], ["export-transfer-words", "vocabulary"]] as const) {
    const button = document.getElementById(id);
    button?.addEventListener("click", async () => {
      setElementBusy(button, true, { disable: true });
      try {
        await exportTransfer(scope);
      } finally {
        setElementBusy(button, false, { disable: true });
      }
    });
  }
  const importTransferButton = document.getElementById("import-transfer");
  importTransferButton?.addEventListener("click", async () => {
    setElementBusy(importTransferButton, true, { disable: true });
    try {
      await importTransfer();
    } finally {
      setElementBusy(importTransferButton, false, { disable: true });
    }
  });

  if (byId<HTMLElement>("choose-data-directory")) byId<HTMLElement>("choose-data-directory").addEventListener("click", async () => {
    if (isAndroidPlatform()) {
      showToast(t("settings.androidDataFolderFixed"));
      return;
    }
    setElementBusy(byId<HTMLElement>("choose-data-directory"), true, { disable: true });
    try {
      if (!await confirmDataFolderChange()) return;
      await flushAllPendingFrontendState();
      const startingRevision = getDurableStateRevision();

      const response = await httpPost("/__store/choose_data_dir", { confirm: true }, { timeoutMs: 60_000 });
      if (!response.ok) throw new Error((await response.text()).trim());
      const result = await response.json();
      if (result.path) {
        if (result.snapshot) {
          await applyLoadedSnapshot(result.snapshot, startingRevision);
        } else {
          state.dataDirectory = result.path;
        }
        syncSettingsControls();
        render();
        showToast(t("settings.dataFolderChanged"));
      }
    } catch (error) {
      console.error(error);
      showToast(t("settings.dataFolderChangeFailed"), "error");
    } finally {
      setElementBusy(byId<HTMLElement>("choose-data-directory"), false, { disable: true });
    }
  });

  const checkUpdatesBtn = document.getElementById("check-updates");
  if (checkUpdatesBtn) checkUpdatesBtn.addEventListener("click", async () => {
    setElementBusy(checkUpdatesBtn, true, { disable: true });
    try {
      const { checkForUpdates } = await import("../../update-checker.js");
      await checkForUpdates({ manual: true });
    } finally {
      setElementBusy(checkUpdatesBtn, false, { disable: true });
    }
  });

  const exportAnkiBtn = document.getElementById("export-anki-tsv");
  if (exportAnkiBtn) exportAnkiBtn.addEventListener("click", async () => {
    setElementBusy(exportAnkiBtn, true, { disable: true });
    try {
      await exportAnkiTsv();
    } finally {
      setElementBusy(exportAnkiBtn, false, { disable: true });
    }
  });

  if (els.ankiExportStatusFilters?.length) {
    els.ankiExportStatusFilters.forEach((input) => {
      input.addEventListener("change", () => {
        const selected = els.ankiExportStatusFilters
          .filter((statusInput) => statusInput.checked)
          .map((statusInput) => statusInput.value);
        updatePreferenceValue("ankiExportStatuses", selected.length ? selected : ["learning"]);
        syncSettingsControls();
      });
    });
  }

  const importAnkiFile = document.getElementById("import-anki-tsv");
  if (importAnkiFile) importAnkiFile.addEventListener("change", importAnkiTsv);

  if (els.clearWords) els.clearWords.addEventListener("click", clearWords);
  if (els.clearLibrary) els.clearLibrary.addEventListener("click", clearLibrary);


  if (byId<HTMLElement>("reset-prefs")) {
    byId<HTMLElement>("reset-prefs").addEventListener("click", async () => {
      const ok = await showConfirmDialog({
        title: t("dialog.confirmTitle"),
        message: t("settings.confirmResetMessage"),
        danger: true
      });
      if (!ok) return;
      const generation = beginWordAlgorithmChange();
      resetPreferences();
      renderLibrary();
      showToast(t("toast.prefsReset"));
      const algorithm = state.preferences.wordDetectionAlgorithm === "classic" ? "classic" : "modern";
      await remapReaderBookmarksForAlgorithm(algorithm);
      if (generation !== currentWordAlgorithmChangeGeneration() || state.preferences.wordDetectionAlgorithm !== algorithm) return;
      renderReader();
    });
  }
}
