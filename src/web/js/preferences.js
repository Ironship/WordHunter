// User preferences: theme, font, size — reads and saves state, updates DOM.
import { state, saveState, createDefaultState, getDefaultDictionaryUrl } from "./state.js";
import { APP_LOCALES, FONT_STACKS, LEARNING_LANGUAGES, LINE_HEIGHTS, OTHER_PROFILE_ID, UI_SCALE } from "./constants.js";
import { els } from "./dom.js";
import { clamp, escapeHtml } from "./utils.js";
import { t } from "./i18n.js";
import { canUseTranslationProvider } from "./translation-provider.js";
import { DEFAULT_LM_STUDIO_ENDPOINT, isDesktopOnlyTranslationProvider, normalizeTranslationProvider, resolveProfileTranslationPair } from "./translator-preferences.js";
import { normalizeLearningColors } from "./reader-colors.js";
import { applyTheme, nextTheme, normalizeTheme } from "./theme.js";
import { isAndroidPlatform } from "./platform.js";
import { themeIcon } from "./icons.js";

let syncStatus = null;

function getAndroidSyncFolderLabel() {
  const getter = window.WordHunterAndroid?.getSyncFolderLabel;
  if (!isAndroidPlatform() || typeof getter !== "function") return "";
  try {
    return String(getter.call(window.WordHunterAndroid) || "");
  } catch (error) {
    console.warn("Failed to read Android sync folder label", error);
    return "";
  }
}

function formatConflictRecord(record) {
  const device = record?.deviceId ? t("settings.syncConflictDevice", { device: record.deviceId }) : "";
  const stateLabel = record?.deleted ? t("settings.syncConflictDeleted") : t("settings.syncConflictUpdated");
  return [stateLabel, device].filter(Boolean).join(" ");
}

function renderSyncConflicts() {
  const conflicts = Array.isArray(state.syncConflicts) ? state.syncConflicts : [];
  const hasConflicts = conflicts.length > 0 || Math.max(0, Number(state.syncConflictCount) || 0) > 0;
  if (els.syncConflictsPanel) {
    els.syncConflictsPanel.hidden = !hasConflicts;
  }
  if (!els.syncConflictsList) return;
  if (!conflicts.length) {
    els.syncConflictsList.innerHTML = hasConflicts
      ? `<p class="muted-copy">${escapeHtml(t("settings.syncConflictRefresh"))}</p>`
      : "";
    return;
  }
  els.syncConflictsList.innerHTML = conflicts.map((conflict) => {
    const key = conflict.key || "";
    const kept = formatConflictRecord(conflict.kept);
    const other = formatConflictRecord(conflict.conflict);
    return `
      <div class="sync-conflict-item" data-conflict-id="${escapeHtml(conflict.id)}">
        <div>
          <div class="sync-conflict-title">${escapeHtml(key || t("settings.syncConflictUnknown"))}</div>
          <div class="sync-conflict-meta">${escapeHtml(t("settings.syncConflictMeta", { kept, other }))}</div>
        </div>
        <div class="sync-conflict-actions">
          <button type="button" class="secondary-button" data-conflict-resolution="keep-current">${escapeHtml(t("settings.syncConflictKeepCurrent"))}</button>
          <button type="button" class="secondary-button" data-conflict-resolution="use-conflict">${escapeHtml(t("settings.syncConflictUseOther"))}</button>
        </div>
      </div>
    `;
  }).join("");
}

function recoveryIssueCount(status) {
  if (!status || typeof status !== "object") return 0;
  let count = Math.max(0, Number(status.skippedRecordCount) || 0)
    + Math.max(0, Number(status.corruptConflictCount) || 0);
  for (const key of ["pendingSaveJournal", "pendingSaveJournalTemp", "pendingWipeJournal", "quarantinedSaveJournal"]) {
    if (status[key] === true) count += 1;
  }
  return count;
}

function renderRecoveryStatus() {
  const status = state.recoveryStatus;
  const issueCount = recoveryIssueCount(status);
  if (els.recoveryStatusPanel) {
    els.recoveryStatusPanel.hidden = issueCount === 0;
  }
  if (!els.recoveryStatusList) return;
  if (issueCount === 0) {
    els.recoveryStatusList.innerHTML = "";
    return;
  }
  const lines = [];
  if (status.pendingSaveJournal) lines.push(t("settings.recoveryPendingSave"));
  if (status.pendingSaveJournalTemp) lines.push(t("settings.recoveryPendingSaveTemp"));
  if (status.pendingWipeJournal) lines.push(t("settings.recoveryPendingWipe"));
  if (status.quarantinedSaveJournal) lines.push(t("settings.recoveryQuarantinedJournal"));
  if (status.skippedRecordCount > 0) {
    lines.push(t("settings.recoverySkippedRecords", { n: status.skippedRecordCount }));
  }
  if (status.corruptConflictCount > 0) {
    lines.push(t("settings.recoveryCorruptConflicts", { n: status.corruptConflictCount }));
  }
  const details = [
    ...(Array.isArray(status.skippedRecords) ? status.skippedRecords : []),
    ...(Array.isArray(status.corruptConflicts) ? status.corruptConflicts : [])
  ].slice(0, 5);
  els.recoveryStatusList.innerHTML = `
    <div class="recovery-status-title">${escapeHtml(t("settings.recoveryStatusTitle", { n: issueCount }))}</div>
    <ul class="recovery-status-lines">
      ${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
    </ul>
    ${details.length ? `<div class="recovery-status-details">${details.map((item) => `<code>${escapeHtml(item.path || item.error || "")}</code>`).join("")}</div>` : ""}
  `;
}

function renderSyncHealth() {
  if (!els.syncHealth) return;
  const health = state.syncHealth;
  if (!health || typeof health !== "object" || health.status === "not-configured") {
    els.syncHealth.textContent = "";
    els.syncHealth.hidden = true;
    return;
  }
  const records = Math.max(0, Math.trunc(Number(health.recordCount) || 0));
  const issues = Math.max(0, Math.trunc(Number(health.issueCount) || 0));
  const keys = {
    ready: "settings.syncHealthReady",
    caution: "settings.syncHealthCaution",
    "needs-attention": "settings.syncHealthNeedsAttention",
    "read-only": "settings.syncHealthReadOnly",
    missing: "settings.syncHealthMissing",
    "not-a-folder": "settings.syncHealthNotFolder"
  };
  els.syncHealth.hidden = false;
  els.syncHealth.textContent = t(keys[health.status] || "settings.syncHealthUnknown", { records, issues });
}

function renderCloudSyncStatus() {
  if (!els.cloudSyncStatus) return;
  const status = state.cloudSyncStatus;
  if (!status || typeof status !== "object" || status.status === "not_configured") {
    els.cloudSyncStatus.textContent = t("settings.cloudSyncStatusDefault");
    return;
  }
  const keys = {
    ready: "settings.cloudSyncStatusReady",
    syncing: "settings.cloudSyncStatusSyncing",
    complete: "settings.cloudSyncStatusComplete",
    not_supported: "settings.cloudSyncStatusNotSupported",
    "needs-attention": "settings.cloudSyncStatusNeedsAttention",
    needs_attention: "settings.cloudSyncStatusNeedsAttention",
    auth_required: "settings.cloudSyncStatusAuthRequired",
    offline: "settings.cloudSyncStatusOffline",
    error: "settings.cloudSyncStatusError"
  };
  els.cloudSyncStatus.textContent = t(keys[status.status] || "settings.cloudSyncStatusUnknown", {
    remote: status.remote || ""
  });
}

function renderSyncthingStatus() {
  if (!els.syncthingStatus) return;
  const st = state.syncthingStatus;
  if (!st) {
    els.syncthingStatus.textContent = t("settings.syncthingNotConfigured");
    if (els.syncthingPeers) els.syncthingPeers.textContent = "";
    return;
  }
  if (!st.running) {
    els.syncthingStatus.textContent = t("settings.syncthingStopped");
    if (els.syncthingPeers) els.syncthingPeers.textContent = "";
    return;
  }
  const deviceId = st.deviceId || "";
  const peerCount = Array.isArray(st.peers) ? st.peers.filter((peer) => peer.connected).length : 0;
  const folderOk = st.folderOk ? "✓" : "✗";
  els.syncthingStatus.textContent = t("settings.syncthingRunning", { deviceId: deviceId.slice(0, 14) + "…", folderOk });
  if (els.syncthingPeers) {
    els.syncthingPeers.textContent = peerCount > 0
      ? t("settings.syncthingPeers", { count: peerCount })
      : t("settings.syncthingNoPeers");
  }
}

function renderSyncthingWizard() {
  const st = state.syncthingStatus;
  const hasSyncDir = !!(state.syncDirectory || getAndroidSyncFolderLabel());
  const running = st?.running === true;
  const peers = Array.isArray(st?.peers) ? st.peers : [];
  const connectedPeers = peers.filter(p => p.connected);
  const steps = document.querySelectorAll(".syncthing-wizard-step[data-step]");

  steps.forEach(step => {
    const num = parseInt(step.dataset.step, 10);
    step.classList.remove("syncthing-wizard-step-active", "syncthing-wizard-step-done");

    if (num === 1) {
      if (hasSyncDir) {
        step.classList.add("syncthing-wizard-step-done");
      } else {
        step.classList.add("syncthing-wizard-step-active");
      }
    } else if (num === 2) {
      if (running) {
        step.classList.add("syncthing-wizard-step-done");
      } else if (hasSyncDir) {
        step.classList.add("syncthing-wizard-step-active");
      }
    } else if (num === 3) {
      if (connectedPeers.length > 0) {
        step.classList.add("syncthing-wizard-step-done");
      } else if (running) {
        step.classList.add("syncthing-wizard-step-active");
      }
    } else if (num === 4) {
      if (connectedPeers.length > 0 && peers.length > 0) {
        step.classList.add("syncthing-wizard-step-done");
      }
    }
  });

  const finalStep = document.getElementById("syncthing-running-step");
  if (finalStep) {
    finalStep.hidden = !running;
    if (running) {
      const statusEl = document.getElementById("syncthing-final-status");
      if (statusEl) {
        const deviceId = st.deviceId || "";
        const peerNames = connectedPeers.map(p => p.name || p.deviceId).join(", ");
        statusEl.textContent = connectedPeers.length > 0
          ? t("settings.syncWizFinalActive", { deviceId: deviceId.slice(0, 14) + "…", peers: peerNames })
          : t("settings.syncWizFinalNoPeers", { deviceId: deviceId.slice(0, 14) + "…" });
      }
    }
  }
}

export function setSyncStatus(status, vars = {}) {
  syncStatus = { status, vars };
  syncSettingsControls();
}

export function themeLabel(theme) {
  const labels = {
    familiar: "toast.themeFamiliar",
    "alternative-familiar": "toast.themeAlternativeFamiliar",
    "classic-auto": "toast.themeClassicAuto",
    "classic-light": "toast.themeClassicLight",
    "classic-dark": "toast.themeClassicDark"
  };
  return t(labels[normalizeTheme(theme)]);
}

export function applyPreferences() {
  const prefs = state.preferences || {};
  const theme = normalizeTheme(prefs.theme);
  if (prefs.theme !== theme) prefs.theme = theme;
  const root = document.documentElement;
  const previousTheme = root.dataset.themePref;
  const previousMode = root.dataset.theme;
  const resolvedTheme = applyTheme(theme);
  if (els.prefTheme) els.prefTheme.value = theme;

  const fontKey = FONT_STACKS[prefs.readerFont] ? prefs.readerFont : "serif";
  const lineKey = LINE_HEIGHTS[prefs.readerLineHeight] ? prefs.readerLineHeight : "normal";
  document.documentElement.style.setProperty("--reader-font-family", FONT_STACKS[fontKey]);
  document.documentElement.style.setProperty("--reader-line-height", String(LINE_HEIGHTS[lineKey]));
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  document.documentElement.dataset.textAlign = prefs.readerTextAlign || "left";
  document.documentElement.dataset.maxWidth = prefs.readerMaxWidth || "wide";
  document.documentElement.style.setProperty("--reader-sidebar-width", `${Math.min(720, Math.max(300, Number(prefs.readerSidebarWidth) || 380))}px`);
  document.documentElement.style.setProperty("--library-sidebar-width", `${Math.min(600, Math.max(280, Number(prefs.librarySidebarWidth) || 360))}px`);
  document.documentElement.style.setProperty("--token-new-bg", prefs.colorNew || "#ff6b6b");
  document.documentElement.style.setProperty("--token-learning-bg", prefs.colorLearning || "#ffb84d");
  document.documentElement.style.setProperty("--token-known-bg", prefs.colorKnown || "#8ce99a");
  document.documentElement.style.setProperty("--token-ignored-bg", prefs.colorIgnored || "#ced4da");
  document.documentElement.classList.toggle("no-token-highlight", prefs.highlightTokens === false);
  document.documentElement.classList.toggle("no-highlight-known-ignored", prefs.hideKnownIgnored === true);
  document.documentElement.classList.toggle("no-card-stats", prefs.showCardStats === false);
  document.documentElement.classList.toggle("no-covers", prefs.showCovers === false);
  document.documentElement.classList.toggle("reader-focus-mode", prefs.readerFocusMode === true && !isAndroidPlatform());
  document.documentElement.classList.toggle("reader-word-panel-hidden", prefs.readerWordPanelVisible === false && !isAndroidPlatform());
  document.documentElement.classList.toggle("touch-controls-mode", prefs.touchControls === true && !isAndroidPlatform());

  const uiScale = isAndroidPlatform() ? UI_SCALE.DEFAULT : clamp(Math.round(Number(prefs.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
  document.documentElement.style.setProperty("--ui-scale", String(uiScale / 100));
  document.documentElement.style.zoom = String(uiScale / 100);

  if (els.themeToggle) {
    const next = nextTheme(theme);
    els.themeToggle.innerHTML = themeIcon(next);
    els.themeToggle.dataset.nextTheme = next;
    els.themeToggle.title = `${t("topbar.themeToggle")}: ${themeLabel(next)}`;
    els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
  }
  if ((previousTheme !== resolvedTheme.theme || previousMode !== resolvedTheme.mode)
    && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("wordhunter:theme-changed", { detail: resolvedTheme }));
  }
}

export function syncSettingsControls() {
  if (els.prefTheme) els.prefTheme.value = normalizeTheme(state.preferences.theme);
  els.prefLocales?.forEach((control) => { control.value = state.preferences.locale || "pl"; });
  els.prefLearningLanguages?.forEach((control) => { control.value = state.preferences.learningLanguage || "en"; });

  const setFlagImages = (kind, lang, supported, fallback) => {
    const flagKey = supported.includes(lang) ? lang : fallback;
    document.querySelectorAll(`[data-language-flag="${kind}"]`).forEach((img) => {
      img.src = `flags/${flagKey}.svg`;
      img.alt = t(`languages.${flagKey}`);
    });
    return flagKey;
  };

  const locale = state.preferences.locale || "pl";
  const appFlagKey = setFlagImages("locale", locale, APP_LOCALES, "pl");
  const appFlagEl = document.getElementById("app-lang-flag");
  if (appFlagEl) {
    appFlagEl.innerHTML = `<img src="flags/${appFlagKey}.svg" alt="${escapeHtml(t(`languages.${appFlagKey}`))}" style="width: 1.5rem; height: 1.5rem; border-radius: 4px; object-fit: cover; flex-shrink: 0; display: block; pointer-events: none;">`;
  }

  const lang = state.preferences.learningLanguage || "en";
  const learnFlagKey = setFlagImages("learning", lang, LEARNING_LANGUAGES, "en");
  const learnFlagEl = document.getElementById("learning-lang-flag");
  if (learnFlagEl) {
    learnFlagEl.innerHTML = `<img src="flags/${learnFlagKey}.svg" alt="${escapeHtml(t(`languages.${learnFlagKey}`))}" style="width: 1.5rem; height: 1.5rem; border-radius: 4px; object-fit: cover; flex-shrink: 0; display: block; pointer-events: none;">`;
  }

  const prefs = state.preferences || {};
  const translationPair = resolveProfileTranslationPair(prefs);
  if (els.prefTranslationLanguageSettings) els.prefTranslationLanguageSettings.hidden = lang !== OTHER_PROFILE_ID;
  if (els.prefTranslationSourceLanguage) els.prefTranslationSourceLanguage.value = prefs.translationSourceLanguage || "";
  if (els.prefTranslationTargetLanguage) els.prefTranslationTargetLanguage.value = prefs.translationTargetLanguage || translationPair.toCode;
  if (els.prefDictionaryUrl) els.prefDictionaryUrl.value = prefs.dictionaryUrl || "";
  if (els.prefDictionaryMode) els.prefDictionaryMode.value = prefs.dictionaryMode || "internal";
  els.prefFont.value = prefs.readerFont || "serif";
  els.prefLineHeight.value = prefs.readerLineHeight || "normal";
  if (els.prefTextAlign) els.prefTextAlign.value = prefs.readerTextAlign || "left";
  if (els.prefMaxWidth) els.prefMaxWidth.value = prefs.readerMaxWidth || "wide";
  if (els.prefReaderFocusMode) els.prefReaderFocusMode.checked = prefs.readerFocusMode === true;
  if (els.prefReaderWordPanelVisible) els.prefReaderWordPanelVisible.checked = prefs.readerWordPanelVisible !== false;
  if (els.readerWordPanelToggle) {
    const visible = prefs.readerWordPanelVisible !== false;
    els.readerWordPanelToggle.setAttribute("aria-pressed", String(visible));
    els.readerWordPanelToggle.textContent = t(visible ? "settings.readerWordPanelHideControl" : "settings.readerWordPanelShowControl");
  }
  if (els.prefWordsPerPage) els.prefWordsPerPage.value = prefs.wordsPerPage || "1000";
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.value = prefs.wordDetectionAlgorithm || "modern";
  if (els.prefSrsAlgorithm) els.prefSrsAlgorithm.value = prefs.srsAlgorithm === "sm2" ? "sm2" : "fsrs";
  if (els.prefTtsRate) els.prefTtsRate.value = prefs.ttsRate || "normal";
  if (els.prefAutoTtsOnWordFocus) els.prefAutoTtsOnWordFocus.checked = prefs.autoTtsOnWordFocus === true;
  if (els.prefTtsWordHighlight) els.prefTtsWordHighlight.checked = prefs.ttsWordHighlight === true;
  if (els.prefStatusSoundsEnabled) els.prefStatusSoundsEnabled.checked = prefs.statusSoundsEnabled !== false;
  const statusSoundPercent = Math.round(clamp(Number(prefs.statusSoundVolume) || 0, 0, 1) * 100);
  if (els.prefStatusSoundVolume) {
    els.prefStatusSoundVolume.value = String(statusSoundPercent);
    els.prefStatusSoundVolume.disabled = prefs.statusSoundsEnabled === false;
  }
  if (els.prefStatusSoundVolumeLabel) {
    els.prefStatusSoundVolumeLabel.textContent = t("settings.statusSoundVolume", { n: statusSoundPercent });
  }
  if (els.prefRemovalBehavior) els.prefRemovalBehavior.value = prefs.removalBehavior || "ignored";
  if (els.ankiExportStatusFilters?.length) {
    const selected = Array.isArray(prefs.ankiExportStatuses) && prefs.ankiExportStatuses.length
      ? prefs.ankiExportStatuses
      : ["learning"];
    const selectedSet = new Set(selected);
    els.ankiExportStatusFilters.forEach((input) => {
      input.checked = selectedSet.has(input.value);
    });
  }
  els.prefFontSize.value = state.readerFontSize || 18;
  if (els.prefFontSizeLabel) els.prefFontSizeLabel.textContent = t("settings.fontSize", { n: state.readerFontSize || 18 });
  if (els.readerFontSizeSlider) els.readerFontSizeSlider.value = String(state.readerFontSize || 18);
  if (els.readerFontSizeValue) els.readerFontSizeValue.textContent = `${state.readerFontSize || 18}px`;
  const uiScale = clamp(Math.round(Number(prefs.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
  if (els.prefUiScale) els.prefUiScale.value = String(uiScale);
  if (els.prefUiScaleLabel) els.prefUiScaleLabel.textContent = t("settings.uiScale", { n: uiScale });
  if (els.prefTouchControls) els.prefTouchControls.checked = prefs.touchControls === true;
  els.prefHighlight.checked = prefs.highlightTokens !== false;
  if (els.readerHighlightToggle) els.readerHighlightToggle.setAttribute("aria-pressed", String(prefs.highlightTokens !== false));
  if (els.prefHideKnown) els.prefHideKnown.checked = prefs.hideKnownIgnored === true;
  if (els.prefInTextReview) els.prefInTextReview.checked = prefs.inTextReview === true;
  if (els.prefDynamicLearningColors) els.prefDynamicLearningColors.checked = prefs.dynamicLearningColors === true;
  if (els.prefLearningColors?.length) {
    const colors = normalizeLearningColors(prefs.learningColors);
    els.prefLearningColors.forEach((input, index) => {
      input.value = colors[index];
      input.title = t("settings.learningColorLevel", { n: index + 1 });
      input.setAttribute("aria-label", input.title);
    });
  }
  if (els.prefLearningColorsRow) els.prefLearningColorsRow.hidden = prefs.dynamicLearningColors !== true;
  if (els.prefReviewGraphType) els.prefReviewGraphType.value = prefs.reviewGraphType || "heatmap";
  els.prefAutoLearn.checked = prefs.autoLearnOnClick === true;
  if (els.prefAutoAddLearning) els.prefAutoAddLearning.checked = prefs.autoAddLearningOnly === true;
  let provider = normalizeTranslationProvider(prefs.translationProvider);
  if (isAndroidPlatform() && isDesktopOnlyTranslationProvider(provider)) {
    provider = "google";
    state.preferences.translationProvider = provider;
    saveState();
  }
  if (els.prefTranslationProvider) els.prefTranslationProvider.value = provider;
  if (els.prefDeepLApiKey) els.prefDeepLApiKey.value = prefs.deeplApiKey || "";
  if (els.prefLmStudioEndpoint) els.prefLmStudioEndpoint.value = prefs.lmStudioEndpoint || DEFAULT_LM_STUDIO_ENDPOINT;
  if (els.prefLmStudioModel) els.prefLmStudioModel.value = prefs.lmStudioModel || "";
  if (els.prefDeepLApiKeyRow) els.prefDeepLApiKeyRow.hidden = provider !== "deepl";
  if (els.prefLmStudioEndpointRow) els.prefLmStudioEndpointRow.hidden = provider !== "lmstudio";
  if (els.prefLmStudioModelRow) els.prefLmStudioModelRow.hidden = provider !== "lmstudio";
  if (els.prefAutoTranslate) els.prefAutoTranslate.checked = prefs.autoTranslateWords === true;
  if (els.prefAutoTranslateRow) {
    const enabled = canUseTranslationProvider();
    els.prefAutoTranslateRow.style.opacity = enabled ? "1" : "0.5";
    els.prefAutoTranslateRow.style.pointerEvents = enabled ? "auto" : "none";
    els.prefAutoTranslateRow.setAttribute("aria-disabled", String(!enabled));
    if (els.prefAutoTranslate) els.prefAutoTranslate.disabled = !enabled;
  }
  if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = prefs.offlineTranslator === true;
  if (els.prefArgosAsDict) {
    els.prefArgosAsDict.checked = prefs.argosAsDict === true;
    if (els.prefArgosAsDictRow) {
      const enabled = provider === "offline" && prefs.offlineTranslator === true;
      els.prefArgosAsDictRow.style.opacity = enabled ? "1" : "0.5";
      els.prefArgosAsDictRow.style.pointerEvents = enabled ? "auto" : "none";
      els.prefArgosAsDictRow.setAttribute("aria-disabled", String(!enabled));
      els.prefArgosAsDict.disabled = !enabled;
    }
  }
  els.prefCardStats.checked = prefs.showCardStats !== false;
  if (els.prefCardStatsMode) els.prefCardStatsMode.value = ["percentages", "counts", "both"].includes(prefs.cardStatsMode) ? prefs.cardStatsMode : "percentages";
  if (els.prefCardStatsModeRow) {
    const enabled = prefs.showCardStats !== false;
    els.prefCardStatsModeRow.style.opacity = enabled ? "1" : "0.5";
    els.prefCardStatsModeRow.setAttribute("aria-disabled", String(!enabled));
    if (els.prefCardStatsMode) els.prefCardStatsMode.disabled = !enabled;
  }
  if (els.prefCovers) els.prefCovers.checked = prefs.showCovers !== false;
  if (els.prefUseEdgeTts) els.prefUseEdgeTts.checked = prefs.useEdgeTts === true;

  if (els.prefColorNew) els.prefColorNew.value = prefs.colorNew || "#ff6b6b";
  if (els.prefColorLearning) els.prefColorLearning.value = prefs.colorLearning || "#ffb84d";
  if (els.prefColorKnown) els.prefColorKnown.value = prefs.colorKnown || "#8ce99a";
  if (els.prefColorIgnored) els.prefColorIgnored.value = prefs.colorIgnored || "#ced4da";
  if (els.storageSummary && state.currentView === "settings") {
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      const kb = (bytes / 1024).toFixed(1);
      let summary = t("settings.storageSummary", {
        words: Object.keys(state.vocab).length,
        texts: state.customTexts.length,
        kb
      });
      els.storageSummary.textContent = summary;
    } catch (error) {
      console.warn(error);
    }
  }
  if (els.dataDirectory) {
    els.dataDirectory.textContent = state.dataDirectory
      ? t("settings.dataFolderPath", { path: state.dataDirectory })
      : t("settings.dataFolderDefault");
  }
  const syncDirectory = state.syncDirectory || getAndroidSyncFolderLabel();
  if (els.syncDirectory) {
    els.syncDirectory.textContent = syncDirectory
      ? t("settings.syncFolderPath", { path: syncDirectory })
      : t("settings.syncFolderDefault");
  }
  if (els.syncStatus) {
    const key = syncStatus
      ? `settings.syncStatus${syncStatus.status[0].toUpperCase()}${syncStatus.status.slice(1)}`
      : (syncDirectory ? "settings.syncStatusReady" : "settings.syncStatusDefault");
    let label = t(key, syncStatus?.vars);
    const conflictCount = Math.max(0, Math.trunc(Number(state.syncConflictCount) || 0));
    if (conflictCount > 0) {
      label += ` ${t("settings.syncConflictCount", { n: conflictCount })}`;
    }
    els.syncStatus.textContent = label;
  }
  renderSyncHealth();
  renderCloudSyncStatus();
  renderSyncthingStatus();
  renderSyncthingWizard();
  renderSyncConflicts();
  renderRecoveryStatus();
  if (els.forceSync) els.forceSync.disabled = typeof window.flushAllPendingFrontendState !== "function";
  if (els.syncthingStart) {
    const running = state.syncthingStatus?.running === true;
    els.syncthingStart.disabled = running || typeof window.flushAllPendingFrontendState !== "function";
  }
  if (els.syncthingStop) {
    const running = state.syncthingStatus?.running === true;
    els.syncthingStop.disabled = !running;
  }
  if (els.syncthingPair) {
    const running = state.syncthingStatus?.running === true;
    els.syncthingPair.disabled = !running;
  }
  if (els.syncthingShowQR) {
    const running = state.syncthingStatus?.running === true;
    els.syncthingShowQR.disabled = !running || !state.syncthingStatus?.deviceId;
  }
}

export function updatePreferenceValue(key, value) {
  state.preferences[key] = value;
  if (["dictionaryUrl", "dictionaryMode", "translationSourceLanguage", "translationTargetLanguage"].includes(key)) {
    const profile = state.profiles?.[state.preferences.learningLanguage];
    if (profile) {
      profile.preferences = profile.preferences || {};
      profile.preferences[key] = value;
    }
  }
  saveState();
  applyPreferences();
}

export function resetPreferences() {
  const defaults = createDefaultState();
  const lastReadTextIds = state.preferences?.lastReadTextIds || {};
  const learningLanguage = state.preferences?.learningLanguage || defaults.preferences.learningLanguage;
  const profilePreferences = state.profiles?.[learningLanguage]?.preferences || {};
  state.preferences = {
    ...defaults.preferences,
    learningLanguage,
    dictionaryUrl: profilePreferences.dictionaryUrl || getDefaultDictionaryUrl(learningLanguage),
    dictionaryMode: profilePreferences.dictionaryMode || "internal",
    translationSourceLanguage: profilePreferences.translationSourceLanguage || "",
    translationTargetLanguage: profilePreferences.translationTargetLanguage || (learningLanguage === OTHER_PROFILE_ID ? state.preferences.locale || "en" : ""),
    lastReadTextIds
  };
  if (state.profiles?.[learningLanguage]) {
    state.profiles[learningLanguage].preferences = {
      ...(state.profiles[learningLanguage].preferences || {}),
      dictionaryUrl: state.preferences.dictionaryUrl,
      dictionaryMode: state.preferences.dictionaryMode,
      translationSourceLanguage: state.preferences.translationSourceLanguage,
      translationTargetLanguage: state.preferences.translationTargetLanguage,
    };
  }
  state.readerFontSize = defaults.readerFontSize;
  saveState();
  applyPreferences();
  syncSettingsControls();
}

export function setReaderFontSize(value) {
  state.readerFontSize = clamp(Number(value) || 18, 14, 28);
  state.preferences.readerFontSize = state.readerFontSize;
  saveState();
  applyPreferences();
  if (els.prefFontSizeLabel) els.prefFontSizeLabel.textContent = t("settings.fontSize", { n: state.readerFontSize });
  if (els.prefFontSize) els.prefFontSize.value = String(state.readerFontSize);
  if (els.readerFontSizeSlider) els.readerFontSizeSlider.value = String(state.readerFontSize);
  if (els.readerFontSizeValue) els.readerFontSizeValue.textContent = `${state.readerFontSize}px`;
}

export function getUiScale() {
  return clamp(Math.round(Number(state.preferences?.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
}

export function setUiScale(value) {
  const stepped = Math.round(Number(value) / UI_SCALE.STEP) * UI_SCALE.STEP;
  const clamped = clamp(stepped || UI_SCALE.DEFAULT, UI_SCALE.MIN, UI_SCALE.MAX);
  state.preferences.uiScale = clamped;
  saveState();
  applyPreferences();
  if (els.prefUiScale) els.prefUiScale.value = String(clamped);
  if (els.prefUiScaleLabel) els.prefUiScaleLabel.textContent = t("settings.uiScale", { n: clamped });
  return clamped;
}
