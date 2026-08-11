import { applyBridgeSnapshotToState, flushAllPendingFrontendState, getDurableStateRevision, runExclusiveStateWrite, state, saveState } from "../state.js";
import { els } from "../dom.js";
import { t, loadLocale, applyTranslations } from "../i18n.js";
import { render } from "../render.js";
import { renderLibrary } from "../views/library.js";
import { getTextById, renderReader } from "../reader/renderer.js";
import { renderWordPanel } from "../reader/word-panel.js";
import { renderReview } from "../views/vocabulary.js";
import { renderDiscover } from "../views/discover.js";
import { applyPreferences, syncSettingsControls, updatePreferenceValue, resetPreferences, setReaderFontSize, setUiScale } from "../preferences.js";
import { showToast } from "../toast.js";
import { clearWords, clearLibrary, exportAnkiTsv, importAnkiTsv, exportTransfer, importTransfer } from "../sync-actions.js";
import { switchLearningLanguage } from "../state.js";
import { acknowledgeBackendSnapshot, loadBackendSnapshot } from "../store-bridge.js";
import { registerUnsavedDialog, showConfirmDialog } from "../dialog-backdrop.js";
import { setElementBusy } from "../loading.js";
import { applyPlatformUi, isAndroidPlatform } from "../platform.js";
import { OFFLINE_TRANSLATOR_LANGUAGES } from "../constants.js";
import { normalizeTranslationLanguageCode, normalizeTranslatorTextPreference, resolveProfileTranslationPair } from "../translator-preferences.js";
import { normalizeAiTextPreference } from "../ai-explainer.js";
import { normalizeSelectedWordPanelItems } from "../state/normalize.js";
import { remapReaderBookmarksForAlgorithm } from "../reader/bookmarks.js";

type ApplyBridgeSnapshotOptions = {
  expectedRevision?: number;
  preserveActiveReader?: boolean;
};

let wordAlgorithmChangeGeneration = 0;

/**
 * Builds the offline-model download dialog markup once (idempotent). Called
 * during app boot before cacheElements() (app.ts); bindSettingsEvents()
 * resolves the elements via getElementById, so boot order guarantees they
 * exist.
 */
export function renderArgosDownloadDialog(): HTMLDialogElement {
  const existing = document.getElementById("argos-download-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#argos-download-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "argos-download-dialog";
  dialog.className = "panel dialog-500";
  dialog.setAttribute("aria-labelledby", "argos-download-title");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 id="argos-download-title" data-i18n="settings.argosDownloadTitle">Download offline models</h2>
    </div>
    <div class="settings-body p-15-g-1">
      <p class="muted-copy" data-i18n="settings.argosDownloadHint">Downloads local translation packages for the selected languages, including pairs with English and your learning language when available.</p>
      <div id="argos-languages-list" class="stack-g-05">
        <label class="status-check justify-start">
          <input type="checkbox" value="en" checked>
          <span data-i18n="languages.en">English</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="pl" checked>
          <span data-i18n="languages.pl">Polish</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="de">
          <span data-i18n="languages.de">German</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="es">
          <span data-i18n="languages.es">Spanish</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="fr">
          <span data-i18n="languages.fr">French</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="zh">
          <span data-i18n="languages.zh">Chinese (Simplified)</span>
        </label>
      </div>
      <p data-i18n="settings.argosDownloadWarning" class="error-text">Note: downloading models will take a while. Do not close the app during the process.</p>
      <div class="justify-end-m-t-1">
        <button id="argos-download-cancel" class="secondary-button" data-i18n="moveBook.cancel">Cancel</button>
        <button id="argos-download-confirm" class="primary-button" data-i18n="settings.argosDownloadConfirm">Download</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

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
  let argosSelectionDirty = false;

  function isArgosDirty() {
    return argosSelectionDirty;
  }

  async function cancelArgosDownload() {
    if (argosDownloadRunning) return;
    argosSelectionDirty = false;
    (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.close();
    if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = false;
    if (els.prefArgosAsDictRow) {
      els.prefArgosAsDictRow.style.opacity = "0.5";
      els.prefArgosAsDictRow.style.pointerEvents = "none";
    }
    syncSettingsControls();
    const { renderTranslator } = await import("../views/translator.js");
    renderTranslator();
  }

  registerUnsavedDialog("argos-download-dialog", isArgosDirty, () => {
    document.getElementById("argos-download-confirm")?.click();
  }, cancelArgosDownload);
  // Settings
  bindPreferenceControls();
  bindSelectedWordPanelSettings();

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
        headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
        body: JSON.stringify({ confirm: true })
      });
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
      setElementBusy(els.chooseDataDirectory, false, { disable: true });
    }
  });

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


  if (els.resetPrefs) {
    els.resetPrefs.addEventListener("click", async () => {
      const ok = await showConfirmDialog({
        title: t("dialog.confirmTitle"),
        message: t("settings.confirmResetMessage"),
        danger: true
      });
      if (!ok) return;
      const generation = ++wordAlgorithmChangeGeneration;
      resetPreferences();
      renderLibrary();
      showToast(t("toast.prefsReset"));
      const algorithm = state.preferences.wordDetectionAlgorithm === "classic" ? "classic" : "modern";
      await remapReaderBookmarksForAlgorithm(algorithm);
      if (generation !== wordAlgorithmChangeGeneration || state.preferences.wordDetectionAlgorithm !== algorithm) return;
      renderReader();
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
    });
  });
  if (els.prefWordsPerPage) els.prefWordsPerPage.addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.readerPage = 1; // reset page when changing words per page
    resetReaderScrollForCurrentText();
    updatePreferenceValue("wordsPerPage", target.value);
    renderReader();
  });
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.addEventListener("change", async (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    const algorithm = target.value === "classic" ? "classic" : "modern";
    const generation = ++wordAlgorithmChangeGeneration;
    await remapReaderBookmarksForAlgorithm(algorithm);
    const selectedAlgorithm = target.value === "classic" ? "classic" : "modern";
    if (generation !== wordAlgorithmChangeGeneration || selectedAlgorithm !== algorithm) return;
    state.preferences.wordDetectionAlgorithm = algorithm;
    for (const position of Object.values(state.readerScrolls || {})) {
      if (position && typeof position === "object") position.wordIndex = null;
    }
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
  const languageControls: Array<[HTMLInputElement | null, string]> = [
    [els.prefTranslationSourceLanguage, "translationSourceLanguage"],
    [els.prefTranslationTargetLanguage, "translationTargetLanguage"]
  ];
  for (const [control, key] of languageControls) {
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
  if (els.prefAiExplanations) {
    els.prefAiExplanations.addEventListener("change", (event: Event) => {
      const target = event.currentTarget as HTMLInputElement;
      updatePreferenceValue("aiExplanationsEnabled", target.checked);
      syncSettingsControls();
      // Keep the word-panel "ai" item in sync with the toggle in both
      // directions: enabling shows the button, disabling hides it. A
      // pre-existing mismatch (ai visible but feature off, or vice versa)
      // must not leave the panel button out of sync with the setting.
      const items = normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems);
      const aiItem = items.find((item) => item.id === "ai");
      if (aiItem && aiItem.visible !== target.checked) {
        aiItem.visible = target.checked;
        saveSelectedWordPanelItems(items);
        if (target.checked) showToast(t("settings.aiPanelItemShown"));
      }
    });
  }
  if (els.prefAiEndpoint) {
    els.prefAiEndpoint.addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationEndpoint", normalizeAiTextPreference("aiExplanationEndpoint", (event.currentTarget as HTMLInputElement).value));
      syncSettingsControls();
    });
  }
  if (els.prefAiModel) {
    els.prefAiModel.addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationModel", normalizeAiTextPreference("aiExplanationModel", (event.currentTarget as HTMLInputElement).value));
      syncSettingsControls();
    });
  }
  if (els.prefAiApiKey) {
    els.prefAiApiKey.addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationApiKey", (event.currentTarget as HTMLInputElement).value.trim());
    });
  }
  if (els.prefAiEffort) {
    els.prefAiEffort.addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationEffort", normalizeAiTextPreference("aiExplanationEffort", (event.currentTarget as HTMLSelectElement).value));
      syncSettingsControls();
    });
  }
  if (els.prefAiAutoTrigger) {
    els.prefAiAutoTrigger.addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationAutoTrigger", (event.currentTarget as HTMLInputElement).checked);
      syncSettingsControls();
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
        
        const languagesList = document.getElementById("argos-languages-list");
        if (languagesList) {
          languagesList.innerHTML = supported.map(lang => `
            <label class="status-check justify-start">
              <input type="checkbox" value="${lang}" ${lang === pair.fromCode || lang === pair.toCode ? "checked" : ""}>
              <span>${translate(`languages.${lang}`) === `languages.${lang}` ? lang.toUpperCase() : translate(`languages.${lang}`)} (${lang.toUpperCase()})</span>
            </label>
          `).join("");
          
          // Update button text with size
          const updateBtnText = () => {
            const count = languagesList.querySelectorAll("input:checked").length;
            const confirmButton = document.getElementById("argos-download-confirm");
            if (confirmButton) confirmButton.textContent = translate("settings.argosDownloadSize", { label: translate("settings.argosDownloadConfirm"), size: count * 150 });
          };
          
          languagesList.querySelectorAll<HTMLInputElement>("input").forEach((checkbox) => {
            checkbox.addEventListener("change", updateBtnText);
            checkbox.addEventListener("change", () => { argosSelectionDirty = true; });
          });
          updateBtnText();
        }

        (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.showModal();
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

  const argosCancelButton = document.getElementById("argos-download-cancel");
  if (argosCancelButton) {
    argosCancelButton.addEventListener("click", cancelArgosDownload);
  }

  const argosConfirmButton = document.getElementById("argos-download-confirm");
  if (argosConfirmButton) {
    argosConfirmButton.addEventListener("click", async () => {
      const languagesList = document.getElementById("argos-languages-list");
      if (!(languagesList instanceof HTMLElement)) return;
      const checkedBoxes = Array.from(languagesList.querySelectorAll<HTMLInputElement>("input:checked"));
      const toCodes = checkedBoxes.map(cb => cb.value);
      
      if (toCodes.length === 0) {
        import("../toast.js").then(m => m.showToast(t("toast.selectAtLeastOneLanguage")));
        return;
      }
      
      setElementBusy(argosConfirmButton, true, { disable: true });
      setElementBusy(document.getElementById("argos-download-dialog"), true);
      argosDownloadRunning = true;
      argosSelectionDirty = false;
      if (argosCancelButton) (argosCancelButton as HTMLButtonElement).disabled = true;
      argosConfirmButton.textContent = t("toast.downloadingWait");
      
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
        (document.getElementById("argos-download-dialog") as HTMLDialogElement | null)?.close();
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
        if (argosCancelButton) (argosCancelButton as HTMLButtonElement).disabled = false;
        setElementBusy(document.getElementById("argos-download-dialog"), false);
        setElementBusy(argosConfirmButton, false, { disable: true });
        argosConfirmButton.textContent = t("settings.argosDownloadConfirm");
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
