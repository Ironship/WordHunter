import { state, saveState, replaceState } from "../state.js";
import { els } from "../dom.js";
import { t, loadLocale, applyTranslations } from "../i18n.js";
import { render } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../views/reader.js";
import { renderReview } from "../views/vocabulary.js";
import { renderDiscover } from "../views/discover.js";
import { applyPreferences, setSyncStatus, syncSettingsControls, updatePreferenceValue, resetPreferences, setReaderFontSize, setUiScale } from "../preferences.js";
import { showToast } from "../toast.js";
import { exportState, importStateFile, clearLocalState, clearWords, clearLibrary, exportAnkiTsv, importAnkiTsv } from "../sync-actions.js";
import { loadState } from "../state/normalize.js";
import { switchLearningLanguage } from "../state.js";
import { registerUnsavedDialog } from "../dialog-backdrop.js";
import { isAndroidPlatform } from "../platform.js";
import { OFFLINE_TRANSLATOR_LANGUAGES } from "../constants.js";
import { normalizeTranslatorTextPreference } from "../translator-preferences.js";

let syncIntervalStarted = false;
let backgroundSyncTimer = null;
let backgroundSyncRunning = false;

function resetReaderScrollForCurrentText() {
  if (!state.currentTextId) return;
  if (!state.readerScrolls) state.readerScrolls = {};
  state.readerScrolls[state.currentTextId] = { wordIndex: null, scrollTop: 0, readerPage: 1 };
}

function confirmDataFolderChange() {
  const message = t("settings.dataFolderConfirm");
  if (typeof HTMLDialogElement === "undefined") return Promise.resolve(window.confirm(message));

  let dialog = document.getElementById("data-folder-confirm-dialog");
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
  dialog.querySelector("h2").textContent = parts.shift() || t("settings.chooseDataFolder");
  const copy = dialog.querySelector(".confirmation-dialog-copy");
  copy.replaceChildren(...parts.map((part) => {
    const paragraph = document.createElement("p");
    paragraph.className = "muted-copy";
    paragraph.textContent = part;
    return paragraph;
  }));
  dialog.querySelector('[data-action="cancel"]').textContent = t("moveBook.cancel");

  return new Promise((resolve) => {
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const confirmButton = dialog.querySelector('[data-action="confirm"]');
    const cleanup = (value) => {
      cancelButton.removeEventListener("click", onCancel);
      confirmButton.removeEventListener("click", onConfirm);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      dialog.close();
      resolve(value);
    };
    const onCancel = (event) => {
      event.preventDefault();
      cleanup(false);
    };
    const onConfirm = () => cleanup(true);
    const onBackdrop = (event) => {
      if (event.target === dialog) cleanup(false);
    };

    cancelButton.addEventListener("click", onCancel);
    confirmButton.addEventListener("click", onConfirm);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onBackdrop);
    dialog.showModal();
  });
}

function waitForAndroidSyncResult(startSync) {
  if (typeof startSync !== "function") return null;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-sync-folder", onResult);
      clearTimeout(timeout);
    };
    const onResult = (event) => {
      cleanup();
      const detail = event.detail || {};
      if (detail.cancelled) {
        resolve(null);
      } else if (detail.success) {
        resolve(detail);
      } else {
        reject(new Error(detail.error || t("settings.dataFolderChangeFailed")));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(t("settings.dataFolderChangeFailed")));
    }, 120000);

    window.addEventListener("wordhunter:android-sync-folder", onResult);
    try {
      const started = startSync();
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

function chooseAndroidSyncFolder() {
  if (typeof window.WordHunterAndroid?.chooseSyncFolder !== "function") return null;
  return waitForAndroidSyncResult(() => window.WordHunterAndroid.chooseSyncFolder());
}

function forceAndroidSyncFolder() {
  if (typeof window.WordHunterAndroid?.forceSyncFolder !== "function") return null;
  return waitForAndroidSyncResult(() => window.WordHunterAndroid.forceSyncFolder());
}

function applyBridgeSnapshot(snapshot, previousView = state.currentView || "settings") {
  window.__bridgeState = snapshot;
  replaceState(loadState(), { save: false });
  state.currentView = previousView;
  syncSettingsControls();
  render();
}

async function reloadActiveDataFolder() {
  if (!window.__qtBridge) return;
  const previousView = state.currentView || "settings";
  const response = await fetch("/__store/load", { cache: "no-store" });
  if (!response.ok) throw new Error(t("toast.syncUnavailable"));
  applyBridgeSnapshot(await response.json(), previousView);
}

async function syncNow({ background = false, saveFirst = true } = {}) {
  if (!window.__qtBridge && typeof window.WordHunterAndroid?.forceSyncFolder !== "function") return false;
  if (!state.syncDirectory && typeof window.WordHunterAndroid?.forceSyncFolder !== "function") {
    if (!background) showToast(t("settings.syncFolderMissing"), "error");
    return false;
  }
  const previousView = state.currentView || "settings";
  if (saveFirst) await saveState();
  const androidResult = await forceAndroidSyncFolder();
  if (androidResult) {
    const snapshotResponse = await fetch("/__store/load", { cache: "no-store" });
    if (!snapshotResponse.ok) throw new Error(t("settings.dataFolderChangeFailed"));
    const snapshot = await snapshotResponse.json();
    snapshot.syncDir = androidResult.path || snapshot.syncDir || state.syncDirectory;
    applyBridgeSnapshot(snapshot, previousView);
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
  if (!response.ok) throw new Error(t("toast.syncUnavailable"));
  const result = await response.json();
  if (result.snapshot) applyBridgeSnapshot(result.snapshot, previousView);
  return true;
}

function startBackgroundSyncJob() {
  if (syncIntervalStarted) return;
  syncIntervalStarted = true;
  const runBackgroundSync = () => {
    if (document.visibilityState === "hidden") return;
    if (backgroundSyncRunning) return;
    backgroundSyncRunning = true;
    syncNow({ background: true, saveFirst: false })
      .catch((error) => console.warn("Background sync failed", error))
      .finally(() => { backgroundSyncRunning = false; });
  };
  const scheduleBackgroundSync = (delayMs = 0) => {
    clearTimeout(backgroundSyncTimer);
    backgroundSyncTimer = window.setTimeout(runBackgroundSync, delayMs);
  };
  scheduleBackgroundSync(0);
  window.addEventListener("wordhunter:sync-saved", () => scheduleBackgroundSync(1500));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleBackgroundSync(0);
  });
  window.setInterval(() => scheduleBackgroundSync(0), 15 * 60 * 1000);
}

function bindPreferenceControls() {
  document.querySelectorAll("[data-pref]").forEach((control) => {
    control.addEventListener("change", () => {
      updatePreferenceValue(
        control.dataset.pref,
        control.type === "checkbox" ? control.checked : control.value
      );
    });
  });
}

function updateTranslatorTextPreference(key, value) {
  updatePreferenceValue(key, normalizeTranslatorTextPreference(key, value));
  syncSettingsControls();
}

export function bindSettingsEvents() {
  function isArgosDirty() {
    return !!els.argosDownloadDialog?.open;
  }

  async function cancelArgosDownload() {
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

  const exportBtn = document.getElementById("export-state");
  if (exportBtn) exportBtn.addEventListener("click", exportState);

  if (els.chooseDataDirectory) els.chooseDataDirectory.addEventListener("click", async () => {
    try {
      if (isAndroidPlatform()) {
        showToast(t("settings.androidDataFolderFixed"));
        return;
      }
      if (!await confirmDataFolderChange()) return;
      window.flushPendingSave?.();

      const response = await fetch("/__store/choose_data_dir", {
        method: "POST",
        headers: { "X-WH-Token": window.WH_TOKEN || "" }
      });
      if (!response.ok) throw new Error(t("settings.dataFolderChangeFailed"));
      const result = await response.json();
      if (result.path) {
        if (result.snapshot) {
          window.__bridgeState = result.snapshot;
          replaceState(loadState(), { save: false });
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
      showToast(t("settings.dataFolderChangeFailed"), "error");
    }
  });

  if (els.chooseSyncDirectory) els.chooseSyncDirectory.addEventListener("click", async () => {
    try {
      await saveState();
      const previousView = state.currentView || "settings";
      const androidResult = await chooseAndroidSyncFolder();
      if (androidResult) {
        const snapshotResponse = await fetch("/__store/load", { cache: "no-store" });
        if (!snapshotResponse.ok) throw new Error(t("settings.dataFolderChangeFailed"));
        const snapshot = await snapshotResponse.json();
        snapshot.syncDir = androidResult.path || snapshot.syncDir || state.syncDirectory;
        applyBridgeSnapshot(snapshot, previousView);
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
        if (result.snapshot) applyBridgeSnapshot(result.snapshot, previousView);
        state.syncDirectory = result.path;
        setSyncStatus("Ready");
        syncSettingsControls();
        showToast(t("settings.syncFolderChanged"));
      }
    } catch (error) {
      console.error(error);
      showToast(t("settings.dataFolderChangeFailed"), "error");
    }
  });

  if (els.forceSync) els.forceSync.addEventListener("click", async () => {
    els.forceSync.disabled = true;
    try {
      const synced = await syncNow();
      if (synced) setSyncStatus("Saved", { time: new Date().toLocaleTimeString() });
    } catch (error) {
      console.error(error);
      setSyncStatus("Error");
      showToast(t("toast.syncUnavailable"), "error");
    } finally {
      setTimeout(syncSettingsControls, 500);
    }
  });

  startBackgroundSyncJob();

  const checkUpdatesBtn = document.getElementById("check-updates");
  if (checkUpdatesBtn) checkUpdatesBtn.addEventListener("click", async () => {
    checkUpdatesBtn.disabled = true;
    try {
      const { checkForUpdates } = await import("../update-checker.js");
      await checkForUpdates({ manual: true });
    } finally {
      checkUpdatesBtn.disabled = false;
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

  els.prefTheme.addEventListener("change", () => { updatePreferenceValue("theme", els.prefTheme.value); renderLibrary(); renderReader(); });
  els.prefLocales?.forEach((control) => {
    control.addEventListener("change", async () => {
      const value = control.value;
      state.preferences.locale = value;
      saveState();
      await loadLocale(value);
      applyTranslations();
      syncSettingsControls();
      render();
      showToast(t("toast.languageChanged", { name: t(`languages.${value}`) }));
    });
  });
  els.prefLearningLanguages?.forEach((control) => {
    control.addEventListener("change", () => {
      switchLearningLanguage(control.value);
      syncSettingsControls();
      render();
      showToast(t("toast.learningLanguageChanged"));
    });
  });
  if (els.prefWordsPerPage) els.prefWordsPerPage.addEventListener("change", (e) => {
    state.readerPage = 1; // reset page when changing words per page
    resetReaderScrollForCurrentText();
    updatePreferenceValue("wordsPerPage", e.target.value);
    renderReader();
  });
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.addEventListener("change", (e) => {
    state.preferences.wordDetectionAlgorithm = e.target.value === "classic" ? "classic" : "modern";
    state.readerPage = 1;
    resetReaderScrollForCurrentText();
    saveState();
    applyPreferences();
    render();
  });
  if (els.prefSrsAlgorithm) els.prefSrsAlgorithm.addEventListener("change", (e) => {
    state.preferences.srsAlgorithm = e.target.value === "sm2" ? "sm2" : "fsrs";
    saveState();
    applyPreferences();
    renderReview();
  });
  if (els.prefInTextReview) els.prefInTextReview.addEventListener("change", (e) => {
    updatePreferenceValue("inTextReview", e.target.checked);
    renderReader();
  });
  if (els.prefReviewGraphType) els.prefReviewGraphType.addEventListener("change", (e) => {
    updatePreferenceValue("reviewGraphType", e.target.value);
    import("../views/vocabulary.js").then(m => m.renderReview());
  });
  if (els.prefTranslationProvider) {
    els.prefTranslationProvider.addEventListener("change", async (e) => {
      updatePreferenceValue("translationProvider", e.target.value);
      syncSettingsControls();
      const { renderTranslator } = await import("../views/translator.js");
      renderTranslator();
    });
  }
  if (els.prefDeepLApiKey) {
    els.prefDeepLApiKey.addEventListener("change", (e) => {
      updateTranslatorTextPreference("deeplApiKey", e.target.value);
    });
  }
  if (els.prefLmStudioEndpoint) {
    els.prefLmStudioEndpoint.addEventListener("change", (e) => {
      updateTranslatorTextPreference("lmStudioEndpoint", e.target.value);
    });
  }
  if (els.prefLmStudioModel) {
    els.prefLmStudioModel.addEventListener("change", (e) => {
      updateTranslatorTextPreference("lmStudioModel", e.target.value);
    });
  }
  if (els.prefOfflineTranslator) {
    els.prefOfflineTranslator.addEventListener("change", async (e) => {
      if (e.target.checked) {
        // Dynamically build the language list in the download dialog
        const { t } = await import("../i18n.js");
        const supported = OFFLINE_TRANSLATOR_LANGUAGES;
        
        if (els.argosLanguagesList) {
          els.argosLanguagesList.innerHTML = supported.map(lang => `
            <label class="status-check" style="justify-content: flex-start; gap: 0.5rem;">
              <input type="checkbox" value="${lang}" ${lang === (state.preferences.locale || "pl") || lang === (state.preferences.learningLanguage || "en") ? "checked" : ""}>
              <span>${t(`languages.${lang}`)} (${lang.toUpperCase()})</span>
            </label>
          `).join("");
          
          // Update button text with size
          const updateBtnText = () => {
            const count = els.argosLanguagesList.querySelectorAll("input:checked").length;
            els.argosDownloadConfirm.textContent = t("settings.argosDownloadSize", { label: t("settings.argosDownloadConfirm"), size: count * 150 });
          };
          
          els.argosLanguagesList.querySelectorAll("input").forEach(cb => cb.addEventListener("change", updateBtnText));
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
      const checkedBoxes = Array.from(els.argosLanguagesList.querySelectorAll("input:checked"));
      const toCodes = checkedBoxes.map(cb => cb.value);
      
      if (toCodes.length === 0) {
        import("../toast.js").then(m => m.showToast(t("toast.selectAtLeastOneLanguage")));
        return;
      }
      
      els.argosDownloadConfirm.disabled = true;
      els.argosDownloadConfirm.textContent = t("toast.downloadingWait");
      
      try {
        const languages = Array.from(new Set(["en", state.preferences.learningLanguage || "en", ...toCodes]));
        const response = await fetch("/__argos/install", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WH-Token": window.WH_TOKEN || ""
          },
          body: JSON.stringify({ from: languages, to: languages })
        });
        
        if (!response.ok) throw new Error("Failed to download models");
        
        updatePreferenceValue("offlineTranslator", true);
        if (els.prefArgosAsDictRow) {
          els.prefArgosAsDictRow.style.opacity = "1";
          els.prefArgosAsDictRow.style.pointerEvents = "auto";
        }
        syncSettingsControls();
        if (els.argosDownloadDialog) els.argosDownloadDialog.close();
        const { refreshTranslatorAvailability, invalidatePackagesCache } = await import("../views/translator.js");
        invalidatePackagesCache();
        await refreshTranslatorAvailability();
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
        els.argosDownloadConfirm.disabled = false;
        els.argosDownloadConfirm.textContent = t("settings.argosDownloadConfirm");
      }
    });
  }

  els.prefCardStats.addEventListener("change", () => { updatePreferenceValue("showCardStats", els.prefCardStats.checked); renderLibrary(); });
  if (els.prefCovers) {
    els.prefCovers.addEventListener("change", () => { updatePreferenceValue("showCovers", els.prefCovers.checked); renderLibrary(); renderDiscover(); });
  }
  
  if (els.prefColorNew) els.prefColorNew.addEventListener("input", (e) => updatePreferenceValue("colorNew", e.target.value));
  if (els.prefColorLearning) els.prefColorLearning.addEventListener("input", (e) => updatePreferenceValue("colorLearning", e.target.value));
  if (els.prefColorKnown) els.prefColorKnown.addEventListener("input", (e) => updatePreferenceValue("colorKnown", e.target.value));
  if (els.prefColorIgnored) els.prefColorIgnored.addEventListener("input", (e) => updatePreferenceValue("colorIgnored", e.target.value));
  if (els.prefDynamicLearningColors) els.prefDynamicLearningColors.addEventListener("change", (e) => {
    updatePreferenceValue("dynamicLearningColors", e.target.checked);
    syncSettingsControls();
    renderReader();
  });
  if (els.prefLearningColors?.length) {
    els.prefLearningColors.forEach((input) => input.addEventListener("input", () => {
      updatePreferenceValue("learningColors", els.prefLearningColors.map((color) => color.value));
      renderReader();
    }));
  }
  
  els.prefFontSize.addEventListener("input", (e) => setReaderFontSize(e.target.value));

  if (els.prefUiScale) {
    els.prefUiScale.addEventListener("input", (e) => {
      setUiScale(e.target.value);
    });
  }

  if (els.readerFontSizeSlider) {
    els.readerFontSizeSlider.addEventListener("input", (e) => setReaderFontSize(e.target.value));
  }
}
