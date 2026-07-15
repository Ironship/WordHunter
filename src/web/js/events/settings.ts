import { applyBridgeSnapshotToState, flushAllPendingFrontendState, getDurableStateRevision, runExclusiveStateWrite, state, saveState } from "../state.js";
import { els } from "../dom.js";
import { t, loadLocale, applyTranslations } from "../i18n.js";
import { render } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { getTextById, renderReader } from "../reader/renderer.js";
import { renderWordPanel } from "../reader/word-panel.js";
import { renderReview } from "../views/vocabulary.js";
import { renderDiscover } from "../views/discover.js";
import { applyPreferences, setSyncStatus, syncSettingsControls, updatePreferenceValue, resetPreferences, setReaderFontSize, setUiScale } from "../preferences.js";
import { showToast } from "../toast.js";
import { exportState, importStateFile, clearLocalState, clearWords, clearLibrary, exportAnkiTsv, importAnkiTsv } from "../sync-actions.js";
import { switchLearningLanguage } from "../state.js";
import { acknowledgeBackendSnapshot, loadBackendSnapshot } from "../store-bridge.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";
import { setElementBusy } from "../loading.js";
import { applyPlatformUi, isAndroidPlatform } from "../platform.js";
import { OFFLINE_TRANSLATOR_LANGUAGES } from "../constants.js";
import { normalizeTranslationLanguageCode, normalizeTranslatorTextPreference, resolveProfileTranslationPair } from "../translator-preferences.js";
import { hydrateActiveLibraryTexts } from "../books.js";
import { normalizeSelectedWordPanelItems } from "../state/normalize.js";

type AndroidSyncResult = {
  requestId?: string;
  path?: string;
  health?: WhRecord;
  terminal?: boolean;
  cancelled?: boolean;
  success?: boolean;
  error?: string;
  status?: string;
};

type SyncNowOptions = {
  background?: boolean;
  saveFirst?: boolean;
};

type ApplyBridgeSnapshotOptions = {
  expectedRevision?: number;
  preserveActiveReader?: boolean;
};

type ApplySyncSnapshotOptions = {
  exclusive?: boolean;
  preserveActiveReader?: boolean;
};

let syncIntervalStarted = false;
let backgroundSyncTimer: number | null = null;
let backgroundSyncRunning = false;

function resetReaderScrollForCurrentText() {
  if (!state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};
  state.readerScrolls[state.currentTextId] = { wordIndex: null, scrollTop: 0, readerPage: 1 };
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

function createAndroidSyncRequestId() {
  return `android-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForAndroidSyncResult(
  startSync: ((requestId: string) => boolean) | null | undefined
): Promise<AndroidSyncResult | null> | null {
  if (typeof startSync !== "function") return null;

  return new Promise<AndroidSyncResult | null>((resolve, reject) => {
    const requestId = createAndroidSyncRequestId();
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-sync-folder", onResult);
      clearTimeout(timeout);
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<AndroidSyncResult>).detail || {};
      if (detail.requestId !== requestId) return;
      if (detail.path) {
        state.syncDirectory = detail.path;
      }
      if (detail.health && typeof detail.health === "object") state.syncHealth = detail.health;
      if (detail.path || detail.health) syncSettingsControls();
      if (detail.terminal === false) return;
      cleanup();
      if (detail.cancelled) {
        resolve(null);
      } else if (detail.success) {
        resolve(detail);
      } else {
        reject(new Error(detail.error || detail.status || t("settings.syncFolderChangeFailed")));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(t("settings.syncFolderChangeFailed")));
    }, 190000);

    window.addEventListener("wordhunter:android-sync-folder", onResult);
    try {
      const started = startSync(requestId);
      if (started === false) {
        cleanup();
        resolve(null);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function chooseAndroidSyncFolder(): Promise<AndroidSyncResult | null> | null {
  if (typeof window.WordHunterAndroid?.chooseSyncFolder !== "function") return null;
  return waitForAndroidSyncResult((requestId) => window.WordHunterAndroid.chooseSyncFolder(window.WH_TOKEN || "", requestId));
}

function forceAndroidSyncFolder(): Promise<AndroidSyncResult | null> | null {
  if (typeof window.WordHunterAndroid?.forceSyncFolder !== "function") return null;
  return waitForAndroidSyncResult((requestId) => window.WordHunterAndroid.forceSyncFolder(window.WH_TOKEN || "", requestId));
}

function showSyncFolderError(error: unknown): void {
  const fallback = t("settings.syncFolderChangeFailed");
  const detail = error instanceof Error ? error.message.trim() : "";
  showToast(detail && detail !== fallback
    ? t("settings.syncFolderChangeFailedDetail", { error: detail })
    : fallback, "error");
}

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

async function applySyncSnapshot(
  snapshot: WhBridgeSnapshot,
  startingRevision: number,
  {
    exclusive = false,
    preserveActiveReader = false
  }: ApplySyncSnapshotOptions = {}
): Promise<boolean> {
  const apply = async (): Promise<boolean> => {
    if (!applyBridgeSnapshot(snapshot, { expectedRevision: startingRevision, preserveActiveReader })) {
      window.dispatchEvent(new CustomEvent("wordhunter:sync-snapshot-skipped"));
      return false;
    }
    try {
      await acknowledgeBackendSnapshot(snapshot);
    } catch (error) {
      window.dispatchEvent(new CustomEvent("wordhunter:sync-snapshot-skipped"));
      throw error;
    }
    return true;
  };
  return exclusive ? runExclusiveStateWrite(apply) : apply();
}

async function reloadActiveDataFolder() {
  if (!window.__qtBridge) return;
  await flushAllPendingFrontendState();
  const startingRevision = getDurableStateRevision();
  const snapshot = await loadBackendSnapshot();
  if (snapshot) await applySyncSnapshot(snapshot, startingRevision, { exclusive: true });
}

async function refreshSyncHealth() {
  if (!window.__qtBridge) return;
  try {
    const response = await fetch("/__store/sync_health", { cache: "no-store" });
    if (!response.ok) return;
    state.syncHealth = await response.json();
    syncSettingsControls();
  } catch (error) {
    console.warn("Sync health check failed", error);
  }
}

async function refreshSyncthingStatus() {
  if (!window.__qtBridge) return;
  try {
    const response = await fetch("/__syncthing/status", { cache: "no-store" });
    if (!response.ok) return;
    state.syncthingStatus = await response.json();
    syncSettingsControls();
  } catch (error) {
    console.warn("Syncthing status check failed", error);
  }
}

export async function syncNow({ background = false, saveFirst = true }: SyncNowOptions = {}): Promise<boolean> {
  if (!window.__qtBridge && typeof window.WordHunterAndroid?.forceSyncFolder !== "function") return false;
  if (!state.syncDirectory && typeof window.WordHunterAndroid?.forceSyncFolder !== "function") {
    if (!background) showToast(t("settings.syncFolderMissing"), "error");
    return false;
  }
  const performSync = async (): Promise<boolean> => {
    const preserveActiveReader = background;
    const startingRevision = getDurableStateRevision();
    let androidResult;
    try {
      androidResult = await forceAndroidSyncFolder();
    } catch (error) {
      // A SAF export can fail after Rust committed the merge. Reloading prevents a
      // subsequent stale frontend save from deleting records imported by that merge.
      try {
        const snapshot = await loadBackendSnapshot();
        if (snapshot) {
          await applySyncSnapshot(snapshot, startingRevision, { exclusive: saveFirst, preserveActiveReader });
        }
      } catch (reloadError) {
        console.warn("Could not reload data after Android sync failure", reloadError);
      }
      throw error;
    }
    if (androidResult) {
      const snapshot = await loadBackendSnapshot();
      if (!snapshot) return false;
      snapshot.syncDir = androidResult.path || snapshot.syncDir || state.syncDirectory;
      await applySyncSnapshot(snapshot, startingRevision, { exclusive: saveFirst, preserveActiveReader });
      return true;
    }
    if (androidResult === null && typeof window.WordHunterAndroid?.forceSyncFolder === "function") {
      if (!background) showToast(t("settings.syncFolderMissing"), "error");
      return false;
    }
    const response = await fetch("/__store/sync_now", {
      method: "POST",
      headers: { "X-WH-Token": window.WH_TOKEN || "" }
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || t("toast.syncUnavailable"));
    }
    const result = await response.json();
    if (result.snapshot) {
      await applySyncSnapshot(result.snapshot, startingRevision, { exclusive: saveFirst, preserveActiveReader });
    }
    if (!background) refreshSyncHealth();
    return true;
  };
  if (saveFirst) await flushAllPendingFrontendState();
  return performSync();
}

async function resolveSyncConflict(id: string, resolution: string): Promise<boolean> {
  if (!window.__qtBridge) return false;
  await flushAllPendingFrontendState();
  const startingRevision = getDurableStateRevision();
  const response = await fetch("/__store/resolve_conflict", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
    body: JSON.stringify({ id, resolution })
  });
  if (!response.ok) throw new Error(t("toast.syncUnavailable"));
  const result = await response.json();
  if (result.snapshot) await applySyncSnapshot(result.snapshot, startingRevision, { exclusive: true });
  return true;
}

function startBackgroundSyncJob() {
  if (syncIntervalStarted) return;
  syncIntervalStarted = true;
  let rerunDelayMs: number | null = null;
  const runBackgroundSync = () => {
    backgroundSyncTimer = null;
    if (document.visibilityState === "hidden") return;
    if (backgroundSyncRunning) {
      rerunDelayMs = rerunDelayMs === null ? 5000 : Math.min(rerunDelayMs, 5000);
      return;
    }
    backgroundSyncRunning = true;
    syncNow({ background: true, saveFirst: true })
      .catch((error) => console.warn("Background sync failed", error))
      .finally(() => {
        backgroundSyncRunning = false;
        if (rerunDelayMs !== null) {
          const delayMs = rerunDelayMs;
          rerunDelayMs = null;
          scheduleBackgroundSync(delayMs);
        }
      });
  };
  const scheduleBackgroundSync = (delayMs = 0) => {
    if (backgroundSyncRunning) {
      rerunDelayMs = rerunDelayMs === null ? delayMs : Math.min(rerunDelayMs, delayMs);
      return;
    }
    if (backgroundSyncTimer !== null) clearTimeout(backgroundSyncTimer);
    backgroundSyncTimer = window.setTimeout(runBackgroundSync, delayMs);
  };
  scheduleBackgroundSync(30000);
  window.addEventListener("wordhunter:sync-saved", () => {
    if (!backgroundSyncRunning) scheduleBackgroundSync(5000);
  });
  window.addEventListener("wordhunter:sync-snapshot-skipped", () => scheduleBackgroundSync(5000));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleBackgroundSync(2000);
      refreshSyncHealth();
      refreshSyncthingStatus();
    }
  });
  window.setInterval(() => scheduleBackgroundSync(), 15 * 60 * 1000);
}

function bindPreferenceControls() {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pref]").forEach((control) => {
    control.addEventListener("change", async () => {
      const key = control.dataset.pref;
      const value = control instanceof HTMLInputElement && control.type === "checkbox"
        ? control.checked
        : key === "statusSoundVolume"
          ? Number(control.value) / 100
          : control.value;
      updatePreferenceValue(
        key,
        value
      );
      if (key === "statusSoundsEnabled" || key === "statusSoundVolume") {
        syncSettingsControls();
        if (state.preferences.statusSoundsEnabled && state.preferences.statusSoundVolume > 0) {
          const { playStatusSound } = await import("../status-sounds.js");
          playStatusSound(key === "statusSoundsEnabled" ? "new" : "known");
        }
      }
    });
  });
}

function saveSelectedWordPanelItems(items: WhSelectedWordPanelItem[]): void {
  window.flushWordFieldSave?.();
  state.preferences.selectedWordPanelItems = normalizeSelectedWordPanelItems(items);
  saveState();
  syncSettingsControls();
  const currentText = getTextById(state.currentTextId);
  if (currentText && state.selectedWord && els.wordPanel) renderWordPanel(currentText);
}

function restoreSelectedWordPanelSettingFocus(id: WhSelectedWordPanelItemId, direction?: "up" | "down"): void {
  const list = els.prefSelectedWordPanelItems as HTMLElement | null;
  if (!direction) {
    (list?.querySelector(`[data-word-panel-item-visible="${id}"]`) as HTMLInputElement | null)?.focus();
    return;
  }
  const preferred = list?.querySelector(
    `[data-word-panel-item-move="${id}"][data-direction="${direction}"]`
  ) as HTMLButtonElement | null;
  const fallbackDirection = direction === "up" ? "down" : "up";
  const fallback = list?.querySelector(
    `[data-word-panel-item-move="${id}"][data-direction="${fallbackDirection}"]`
  ) as HTMLButtonElement | null;
  const checkbox = list?.querySelector(`[data-word-panel-item-visible="${id}"]`) as HTMLInputElement | null;
  const target = preferred && !preferred.disabled
    ? preferred
    : fallback && !fallback.disabled ? fallback : checkbox;
  target?.focus();
}

function bindSelectedWordPanelSettings(): void {
  const list = els.prefSelectedWordPanelItems;
  if (!list) return;
  list.addEventListener("change", (event: Event) => {
    const input = event.target instanceof HTMLInputElement
      ? event.target.closest("[data-word-panel-item-visible]") as HTMLInputElement | null
      : null;
    const id = input?.dataset.wordPanelItemVisible as WhSelectedWordPanelItemId | undefined;
    if (!id) return;
    const items = normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.visible = input.checked;
    saveSelectedWordPanelItems(items);
    restoreSelectedWordPanelSettingFocus(id);
  });
  list.addEventListener("click", (event: MouseEvent) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-word-panel-item-move]") as HTMLButtonElement | null
      : null;
    const id = button?.dataset.wordPanelItemMove as WhSelectedWordPanelItemId | undefined;
    if (!id || button.disabled) return;
    const items = normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems);
    const index = items.findIndex((item) => item.id === id);
    const nextIndex = index + (button.dataset.direction === "up" ? -1 : 1);
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
    saveSelectedWordPanelItems(items);
    restoreSelectedWordPanelSettingFocus(id, button.dataset.direction as "up" | "down");
  });
}

function updateTranslatorTextPreference(key: string, value: unknown): void {
  updatePreferenceValue(key, normalizeTranslatorTextPreference(key, value));
  syncSettingsControls();
}

export function bindSettingsEvents() {
  let argosDownloadRunning = false;

  function isArgosDirty() {
    return !!els.argosDownloadDialog?.open;
  }

  async function cancelArgosDownload() {
    if (argosDownloadRunning) return;
    if (els.argosDownloadDialog) els.argosDownloadDialog.close();
    if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
    updatePreferenceValue("offlineTranslator", false);
    if (els.prefArgosAsDictRow) {
      els.prefArgosAsDictRow.style.opacity = "0.5";
      els.prefArgosAsDictRow.style.pointerEvents = "none";
    }
    syncSettingsControls();
    const { renderTranslator } = await import("../views/translator.js");
    renderTranslator();
  }

  registerUnsavedDialog("argos-download-dialog", isArgosDirty, () => {
    els.argosDownloadConfirm.click();
  }, cancelArgosDownload);
  // Settings
  bindPreferenceControls();
  bindSelectedWordPanelSettings();

  const exportBtn = document.getElementById("export-state");
  if (exportBtn) exportBtn.addEventListener("click", exportState);

  if (els.chooseDataDirectory) els.chooseDataDirectory.addEventListener("click", async () => {
    if (isAndroidPlatform()) {
      showToast(t("settings.androidDataFolderFixed"));
      return;
    }
    setElementBusy(els.chooseDataDirectory, true, { disable: true });
    try {
      if (!await confirmDataFolderChange()) return;
      await flushAllPendingFrontendState();
      const startingRevision = getDurableStateRevision();

      const response = await fetch("/__store/choose_data_dir", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error((await response.text()).trim());
      const result = await response.json();
      if (result.path) {
        if (result.snapshot) {
          await applySyncSnapshot(result.snapshot, startingRevision, { exclusive: true });
        } else {
          state.dataDirectory = result.path;
        }
        setSyncStatus("Ready");
        syncSettingsControls();
        render();
        showToast(t("settings.dataFolderChanged"));
      }
    } catch (error) {
      console.error(error);
      showSyncFolderError(error);
    } finally {
      setElementBusy(els.chooseDataDirectory, false, { disable: true });
    }
  });

  if (els.prepareSyncDirectory) els.prepareSyncDirectory.addEventListener("click", async () => {
    setElementBusy(els.prepareSyncDirectory, true, { disable: true });
    try {
      await flushAllPendingFrontendState();
      const startingRevision = getDurableStateRevision();
      const androidResult = await chooseAndroidSyncFolder();
      if (androidResult) {
        const snapshot = await loadBackendSnapshot();
        if (!snapshot) return;
        snapshot.syncDir = androidResult.path || snapshot.syncDir || state.syncDirectory;
        await applySyncSnapshot(snapshot, startingRevision, { exclusive: true });
        setSyncStatus("Ready");
        showToast(t("settings.syncFolderChanged"));
        return;
      }
      if (androidResult === null && typeof window.WordHunterAndroid?.chooseSyncFolder === "function") return;

      const response = await fetch("/__store/prepare_sync_dir", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error((await response.text()).trim());
      const result = await response.json();
      if (result.snapshot) await applySyncSnapshot(result.snapshot, startingRevision, { exclusive: true });
      if (result.path) state.syncDirectory = result.path;
      if (result.health) state.syncHealth = result.health;
      setSyncStatus("Ready");
      syncSettingsControls();
      showToast(t("settings.syncFolderChanged"));
    } catch (error) {
      console.error(error);
      showSyncFolderError(error);
    } finally {
      setElementBusy(els.prepareSyncDirectory, false, { disable: true });
    }
  });

  if (els.syncthingStart) els.syncthingStart.addEventListener("click", async () => {
    setElementBusy(els.syncthingStart, true, { disable: true });
    try {
      const response = await fetch("/__syncthing/start", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error(await response.text());
      state.syncthingStatus = await response.json();
      syncSettingsControls();
      showToast(t("settings.syncthingStarted"));
    } catch (error) {
      console.error(error);
      showToast(error.message || t("settings.syncthingError"), "error");
    } finally {
      setElementBusy(els.syncthingStart, false, { disable: true });
      refreshSyncthingStatus();
    }
  });

  if (els.syncthingStop) els.syncthingStop.addEventListener("click", async () => {
    setElementBusy(els.syncthingStop, true, { disable: true });
    try {
      const response = await fetch("/__syncthing/stop", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error(await response.text());
      state.syncthingStatus = await response.json();
      syncSettingsControls();
      showToast(t("settings.syncthingStopped"));
    } catch (error) {
      console.error(error);
      showToast(error.message || t("settings.syncthingError"), "error");
    } finally {
      setElementBusy(els.syncthingStop, false, { disable: true });
      refreshSyncthingStatus();
    }
  });

  if (els.syncthingPair) els.syncthingPair.addEventListener("click", async () => {
    const deviceId = prompt(t("settings.syncthingPairPrompt"));
    if (!deviceId) return;
    const deviceName = prompt(t("settings.syncthingPairNamePrompt")) || deviceId;
    setElementBusy(els.syncthingPair, true, { disable: true });
    try {
      const response = await fetch("/__syncthing/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({ deviceId, deviceName })
      });
      if (!response.ok) throw new Error(await response.text());
      state.syncthingStatus = await response.json();
      syncSettingsControls();
      showToast(t("settings.syncthingPaired"));
    } catch (error) {
      console.error(error);
      showToast(error.message || t("settings.syncthingError"), "error");
    } finally {
      setElementBusy(els.syncthingPair, false, { disable: true });
      refreshSyncthingStatus();
    }
  });

  if (els.syncthingShowQR) els.syncthingShowQR.addEventListener("click", async () => {
    setElementBusy(els.syncthingShowQR, true, { disable: true });
    try {
      const qrResponse = await fetch("/__syncthing/qr", { cache: "no-store" });
      if (!qrResponse.ok) throw new Error(await qrResponse.text());
      const svg = await qrResponse.text();
      const statusResponse = await fetch("/__syncthing/status", { cache: "no-store" });
      const st = statusResponse.ok ? await statusResponse.json() : {};
      if (els.syncthingQRContainer) els.syncthingQRContainer.innerHTML = svg;
      if (els.syncthingQRDeviceID) {
        els.syncthingQRDeviceID.textContent = st.deviceId
          ? `ID: ${st.deviceId}`
          : "";
      }
      if (els.syncthingQRDialog && typeof els.syncthingQRDialog.showModal === "function") {
        els.syncthingQRDialog.showModal();
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || t("settings.syncthingError"), "error");
    } finally {
      setElementBusy(els.syncthingShowQR, false, { disable: true });
    }
  });

  if (els.syncthingQRClose) els.syncthingQRClose.addEventListener("click", () => {
    if (els.syncthingQRDialog) els.syncthingQRDialog.close();
  });
  if (els.syncthingQRDialog) {
    els.syncthingQRDialog.addEventListener("click", (event: MouseEvent) => {
      if (event.target === els.syncthingQRDialog) els.syncthingQRDialog.close();
    });
  }

  if (els.chooseSyncDirectory) els.chooseSyncDirectory.addEventListener("click", async () => {
    setElementBusy(els.chooseSyncDirectory, true, { disable: true });
    try {
      await flushAllPendingFrontendState();
      const startingRevision = getDurableStateRevision();
      const androidResult = await chooseAndroidSyncFolder();
      if (androidResult) {
        const snapshot = await loadBackendSnapshot();
        if (!snapshot) return;
        snapshot.syncDir = androidResult.path || snapshot.syncDir || state.syncDirectory;
        await applySyncSnapshot(snapshot, startingRevision, { exclusive: true });
        setSyncStatus("Ready");
        showToast(t("settings.syncFolderChanged"));
        return;
      }
      if (androidResult === null && typeof window.WordHunterAndroid?.chooseSyncFolder === "function") return;

      const response = await fetch("/__store/choose_sync_dir", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error(t("settings.dataFolderChangeFailed"));
      const result = await response.json();
      if (result.path) {
        if (result.snapshot) await applySyncSnapshot(result.snapshot, startingRevision, { exclusive: true });
        state.syncDirectory = result.path;
        setSyncStatus("Ready");
        await refreshSyncHealth();
        syncSettingsControls();
        showToast(t("settings.syncFolderChanged"));
      }
    } catch (error) {
      console.error(error);
      showToast(t("settings.dataFolderChangeFailed"), "error");
    } finally {
      setElementBusy(els.chooseSyncDirectory, false, { disable: true });
    }
  });

  if (els.forceSync) els.forceSync.addEventListener("click", async () => {
    setElementBusy(els.forceSync, true, { disable: true });
    try {
      const synced = await syncNow();
      if (synced) setSyncStatus("Saved", { time: new Date().toLocaleTimeString() });
    } catch (error) {
      console.error(error);
      setSyncStatus("Error");
      showToast(error.message || t("toast.syncUnavailable"), "error");
    } finally {
      setElementBusy(els.forceSync, false, { disable: true });
      setTimeout(syncSettingsControls, 500);
    }
  });

  if (els.syncConflictsList) {
    els.syncConflictsList.addEventListener("click", async (event: MouseEvent) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-conflict-resolution]")
        : null;
      if (!button) return;
      const item = button.closest<HTMLElement>("[data-conflict-id]");
      const id = item?.dataset.conflictId;
      const resolution = button.dataset.conflictResolution;
      if (!id || !resolution) return;
      setElementBusy(button, true, { disable: true });
      try {
        await resolveSyncConflict(id, resolution);
        showToast(t("settings.syncConflictResolved"));
      } catch (error) {
        console.warn("resolve conflict failed", error);
        showToast(t("toast.syncUnavailable"), "error");
      } finally {
        setElementBusy(button, false, { disable: true });
      }
    });
  }

  startBackgroundSyncJob();
  window.addEventListener("wordhunter:view-changed", (event) => {
    if ((event as CustomEvent<{ view?: string }>).detail?.view !== "sync") return;
    refreshSyncHealth();
    refreshSyncthingStatus();
  });
  refreshSyncHealth();
  refreshSyncthingStatus();

  const checkUpdatesBtn = document.getElementById("check-updates");
  if (checkUpdatesBtn) checkUpdatesBtn.addEventListener("click", async () => {
    setElementBusy(checkUpdatesBtn, true, { disable: true });
    try {
      const { checkForUpdates } = await import("../update-checker.js");
      await checkForUpdates({ manual: true });
    } finally {
      setElementBusy(checkUpdatesBtn, false, { disable: true });
    }
  });

  const exportAnkiBtn = document.getElementById("export-anki-tsv");
  if (exportAnkiBtn) exportAnkiBtn.addEventListener("click", exportAnkiTsv);

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

  const importFile = document.getElementById("import-state");
  if (importFile) importFile.addEventListener("change", importStateFile);

  const importAnkiFile = document.getElementById("import-anki-tsv");
  if (importAnkiFile) importAnkiFile.addEventListener("change", importAnkiTsv);

  if (els.clearWords) els.clearWords.addEventListener("click", clearWords);
  if (els.clearLibrary) els.clearLibrary.addEventListener("click", clearLibrary);
  if (els.clearState) els.clearState.addEventListener("click", clearLocalState);

  if (els.resetPrefs) {
    els.resetPrefs.addEventListener("click", () => {
      resetPreferences();
      renderLibrary();
      renderReader();
      showToast(t("toast.prefsReset"));
    });
  }

  els.prefLocales?.forEach((control) => {
    control.addEventListener("change", async () => {
      const value = control.value;
      state.preferences.locale = value;
      saveState();
      await loadLocale(value);
      applyTranslations();
      applyPlatformUi();
      applyPreferences();
      syncSettingsControls();
      render();
      showToast(t("toast.languageChanged", { name: t(`languages.${value}`) }));
    });
  });
  els.prefLearningLanguages?.forEach((control) => {
    control.addEventListener("change", () => {
      switchLearningLanguage(control.value);
      applyPreferences();
      syncSettingsControls();
      render();
      showToast(t("toast.learningLanguageChanged"));
      const language = control.value;
      hydrateActiveLibraryTexts()
        .then((current) => {
          if (current && state.preferences.learningLanguage === language && state.currentView === "library") renderLibrary();
        })
        .catch((error) => console.warn("Failed to load books for the selected profile", error));
    });
  });
  if (els.prefWordsPerPage) els.prefWordsPerPage.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.readerPage = 1; // reset page when changing words per page
    resetReaderScrollForCurrentText();
    updatePreferenceValue("wordsPerPage", target.value);
    renderReader();
  });
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.preferences.wordDetectionAlgorithm = target.value === "classic" ? "classic" : "modern";
    state.readerPage = 1;
    resetReaderScrollForCurrentText();
    saveState();
    applyPreferences();
    render();
  });
  if (els.prefSrsAlgorithm) els.prefSrsAlgorithm.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.preferences.srsAlgorithm = target.value === "sm2" ? "sm2" : "fsrs";
    saveState();
    applyPreferences();
    renderReview();
  });
  if (els.prefInTextReview) els.prefInTextReview.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    updatePreferenceValue("inTextReview", target.checked);
    renderReader();
  });
  if (els.prefReviewGraphType) els.prefReviewGraphType.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    updatePreferenceValue("reviewGraphType", target.value);
    import("../views/vocabulary.js").then(m => m.renderReview());
  });
  if (els.prefTranslationProvider) {
    els.prefTranslationProvider.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLSelectElement;
      updatePreferenceValue("translationProvider", target.value);
      syncSettingsControls();
      const { renderTranslator } = await import("../views/translator.js");
      renderTranslator();
    });
  }
  for (const [control, key] of [
    [els.prefTranslationSourceLanguage, "translationSourceLanguage"],
    [els.prefTranslationTargetLanguage, "translationTargetLanguage"]
  ]) {
    if (!control) continue;
    control.addEventListener("input", () => control.setCustomValidity(""));
    control.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      const raw = target.value.trim();
      const value = normalizeTranslationLanguageCode(raw);
      if (raw && !value) {
        target.setCustomValidity(t("settings.translationLanguageInvalid"));
        target.reportValidity();
        return;
      }
      target.setCustomValidity("");
      target.value = value;
      updatePreferenceValue(key, value);
      syncSettingsControls();
      const { renderTranslator } = await import("../views/translator.js");
      renderTranslator();
      renderReader();
    });
  }
  if (els.prefDeepLApiKey) {
    els.prefDeepLApiKey.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("deeplApiKey", (event.currentTarget as HTMLInputElement).value);
    });
  }
  if (els.prefLmStudioEndpoint) {
    els.prefLmStudioEndpoint.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("lmStudioEndpoint", (event.currentTarget as HTMLInputElement).value);
    });
  }
  if (els.prefLmStudioModel) {
    els.prefLmStudioModel.addEventListener("change", (event: Event) => {
      updateTranslatorTextPreference("lmStudioModel", (event.currentTarget as HTMLInputElement).value);
    });
  }
  if (els.prefOfflineTranslator) {
    els.prefOfflineTranslator.addEventListener("change", async (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      if (target.checked) {
        const pair = resolveProfileTranslationPair(state.preferences);
        if (!pair.configured) {
          target.checked = false;
          showToast(t("translator.providerUnavailable"), "error");
          return;
        }
        // Dynamically build the language list in the download dialog
        const { t: translate } = await import("../i18n.js");
        const supported = Array.from(new Set([...OFFLINE_TRANSLATOR_LANGUAGES, pair.fromCode, pair.toCode].filter(Boolean)));
        
        if (els.argosLanguagesList) {
          els.argosLanguagesList.innerHTML = supported.map(lang => `
            <label class="status-check" style="justify-content: flex-start; gap: 0.5rem;">
              <input type="checkbox" value="${lang}" ${lang === pair.fromCode || lang === pair.toCode ? "checked" : ""}>
              <span>${translate(`languages.${lang}`) === `languages.${lang}` ? lang.toUpperCase() : translate(`languages.${lang}`)} (${lang.toUpperCase()})</span>
            </label>
          `).join("");
          
          // Update button text with size
          const updateBtnText = () => {
            const count = els.argosLanguagesList.querySelectorAll("input:checked").length;
            els.argosDownloadConfirm.textContent = translate("settings.argosDownloadSize", { label: translate("settings.argosDownloadConfirm"), size: count * 150 });
          };
          
          (els.argosLanguagesList as HTMLElement).querySelectorAll<HTMLInputElement>("input").forEach((checkbox) => checkbox.addEventListener("change", updateBtnText));
          updateBtnText();
        }

        if (els.argosDownloadDialog) {
          els.argosDownloadDialog.showModal();
        }
      } else {
        updatePreferenceValue("offlineTranslator", false);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        if (els.prefArgosAsDict) {
          els.prefArgosAsDict.checked = false;
          updatePreferenceValue("argosAsDict", false);
        }
        syncSettingsControls();
        const { renderTranslator } = await import("../views/translator.js");
        renderTranslator();
      }
    });
  }

  if (els.argosDownloadCancel) {
    els.argosDownloadCancel.addEventListener("click", cancelArgosDownload);
  }

  if (els.argosDownloadConfirm) {
    els.argosDownloadConfirm.addEventListener("click", async () => {
      const languagesList = els.argosLanguagesList as HTMLElement;
      const checkedBoxes = Array.from(languagesList.querySelectorAll<HTMLInputElement>("input:checked"));
      const toCodes = checkedBoxes.map(cb => cb.value);
      
      if (toCodes.length === 0) {
        import("../toast.js").then(m => m.showToast(t("toast.selectAtLeastOneLanguage")));
        return;
      }
      
      setElementBusy(els.argosDownloadConfirm, true, { disable: true });
      setElementBusy(els.argosDownloadDialog, true);
      argosDownloadRunning = true;
      if (els.argosDownloadCancel) els.argosDownloadCancel.disabled = true;
      els.argosDownloadConfirm.textContent = t("toast.downloadingWait");
      
      try {
        const pair = resolveProfileTranslationPair(state.preferences);
        const languages = Array.from(new Set(["en", pair.fromCode, pair.toCode, ...toCodes].filter(Boolean)));
        const response = await fetch("/__argos/install", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WH-Token": window.WH_TOKEN || ""
          },
          body: JSON.stringify({ from: languages, to: languages })
        });
        
        if (!response.ok) throw new Error("Failed to download models");
        const result = await response.json();
        if (!Number.isFinite(result.installed)) throw new Error("Invalid model installation response");
        const { refreshTranslatorAvailability, hasModelForPair, invalidatePackagesCache, renderTranslator } = await import("../views/translator.js");
        invalidatePackagesCache();
        await refreshTranslatorAvailability();
        if (!hasModelForPair(pair.fromCode, pair.toCode)) throw new Error("No matching translation models were installed");
        updatePreferenceValue("offlineTranslator", true);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "1";
          els.prefArgosAsDictRow.style.pointerEvents = "auto";
        }
        syncSettingsControls();
        if (els.argosDownloadDialog) els.argosDownloadDialog.close();
        renderTranslator();
        import("../toast.js").then(m => m.showToast(t("toast.modelsDownloaded")));
      } catch (err) {
        console.error("Offline translator install error", err);
        import("../toast.js").then(m => m.showToast(t("toast.modelsDownloadError")));
        if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "0.5";
          els.prefArgosAsDictRow.style.pointerEvents = "none";
        }
        updatePreferenceValue("offlineTranslator", false);
        syncSettingsControls();
        const { renderTranslator } = await import("../views/translator.js");
        renderTranslator();
      } finally {
        argosDownloadRunning = false;
        if (els.argosDownloadCancel) els.argosDownloadCancel.disabled = false;
        setElementBusy(els.argosDownloadDialog, false);
        setElementBusy(els.argosDownloadConfirm, false, { disable: true });
        els.argosDownloadConfirm.textContent = t("settings.argosDownloadConfirm");
      }
    });
  }

  els.prefCardStats.addEventListener("change", () => {
    updatePreferenceValue("showCardStats", els.prefCardStats.checked);
    syncSettingsControls();
    renderLibrary();
  });
  if (els.prefCardStatsMode) {
    els.prefCardStatsMode.addEventListener("change", () => {
      updatePreferenceValue("cardStatsMode", els.prefCardStatsMode.value);
      renderLibrary();
    });
  }
  if (els.prefCovers) {
    els.prefCovers.addEventListener("change", () => { updatePreferenceValue("showCovers", els.prefCovers.checked); renderLibrary(); renderDiscover(); });
  }
  
  if (els.prefColorNew) els.prefColorNew.addEventListener("input", (event: Event) => updatePreferenceValue("colorNew", (event.currentTarget as HTMLInputElement).value));
  if (els.prefColorLearning) els.prefColorLearning.addEventListener("input", (event: Event) => updatePreferenceValue("colorLearning", (event.currentTarget as HTMLInputElement).value));
  if (els.prefColorKnown) els.prefColorKnown.addEventListener("input", (event: Event) => updatePreferenceValue("colorKnown", (event.currentTarget as HTMLInputElement).value));
  if (els.prefColorIgnored) els.prefColorIgnored.addEventListener("input", (event: Event) => updatePreferenceValue("colorIgnored", (event.currentTarget as HTMLInputElement).value));
  if (els.prefDynamicLearningColors) els.prefDynamicLearningColors.addEventListener("change", (event: Event) => {
    updatePreferenceValue("dynamicLearningColors", (event.currentTarget as HTMLInputElement).checked);
    syncSettingsControls();
    renderReader();
  });
  if (els.prefLearningColors?.length) {
    els.prefLearningColors.forEach((input) => input.addEventListener("input", () => {
      updatePreferenceValue("learningColors", els.prefLearningColors.map((color) => color.value));
      renderReader();
    }));
  }
  
  els.prefFontSize.addEventListener("input", (event: Event) => setReaderFontSize((event.currentTarget as HTMLInputElement).value));

  if (els.prefUiScale) {
    els.prefUiScale.addEventListener("input", (event: Event) => {
      setUiScale((event.currentTarget as HTMLInputElement).value);
    });
  }

  if (els.readerFontSizeSlider) {
    els.readerFontSizeSlider.addEventListener("input", () => setReaderFontSize(els.readerFontSizeSlider.value));
  }
}
