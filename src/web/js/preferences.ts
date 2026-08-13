// User preferences: theme, font, size — reads and saves state, updates DOM.
import { state, saveState, createDefaultState, getDefaultDictionaryUrl } from "./state.js";
import { APP_LOCALES, FONT_STACKS, LEARNING_LANGUAGES, LINE_HEIGHTS, OTHER_PROFILE_ID, UI_SCALE } from "./constants.js";
import { els } from "./dom.js";
import { clamp, escapeAttribute, escapeHtml } from "./utils.js";
import { getLocale, t } from "./i18n.js";
import { canUseTranslationProvider } from "./translation-provider.js";
import { DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, normalizeAiTextPreference } from "./ai-explainer.js";
import { DEFAULT_LM_STUDIO_ENDPOINT, isDesktopOnlyTranslationProvider, normalizeTranslationProvider, resolveProfileTranslationPair } from "./translator-preferences.js";
import { normalizeLearningColors } from "./reader-colors.js";
import { applyTheme, nextTheme, normalizeTheme, type ThemeName } from "./theme.js";
import { isAndroidPlatform } from "./platform.js";
import { themeIcon } from "./icons.js";
import { normalizeSelectedWordPanelItems, rekeyActiveVocabForLocale } from "./state/normalize.js";
import { postStoreJson } from "./store-bridge.js";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function localeSelects(): HTMLSelectElement[] {
  return [
    byId<HTMLSelectElement>("pref-locale-sidebar"),
    byId<HTMLSelectElement>("pref-locale-settings"),
    byId<HTMLSelectElement>("pref-locale-onboarding"),
  ].filter((control): control is HTMLSelectElement => control !== null);
}

function learningLanguageSelects(): HTMLSelectElement[] {
  return [
    byId<HTMLSelectElement>("pref-learning-language-sidebar"),
    byId<HTMLSelectElement>("pref-learning-language-settings"),
    byId<HTMLSelectElement>("pref-learning-language-onboarding"),
  ].filter((control): control is HTMLSelectElement => control !== null);
}

function learningColorInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("[data-learning-color]"));
}


let queuedNativeUiScale: number | null = null;
let nativeUiScaleQueue: Promise<void> = Promise.resolve();

function applyUiScale(uiScale: number): Promise<void> {
  const root = document.documentElement;
  const scaleFactor = uiScale / 100;
  if (isAndroidPlatform()) {
    root.style.setProperty("--ui-scale", "1");
    root.style.zoom = "1";
    return Promise.resolve();
  }
  if (!window.__qtBridge) {
    root.style.setProperty("--ui-scale", String(scaleFactor));
    root.style.zoom = String(scaleFactor);
    return Promise.resolve();
  }

  root.style.setProperty("--ui-scale", "1");
  root.style.zoom = "1";
  if (queuedNativeUiScale === uiScale) return nativeUiScaleQueue;

  queuedNativeUiScale = uiScale;
  nativeUiScaleQueue = nativeUiScaleQueue
    .then(() => postStoreJson("/__window/zoom", { percent: uiScale }).then(() => {}))
    .catch((error) => {
      if (queuedNativeUiScale === uiScale) queuedNativeUiScale = null;
      console.warn("Failed to apply native window zoom", error);
    });
  return nativeUiScaleQueue;
}

function recoveryIssueCount(status: WhRecoveryStatus | null): number {
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
  if (byId<HTMLElement>("recovery-status-panel")) {
    byId<HTMLElement>("recovery-status-panel").hidden = issueCount === 0;
  }
  if (!byId<HTMLElement>("recovery-status-list")) return;
  if (issueCount === 0) {
    byId<HTMLElement>("recovery-status-list").innerHTML = "";
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
  byId<HTMLElement>("recovery-status-list").innerHTML = `
    <div class="recovery-status-title">${escapeHtml(t("settings.recoveryStatusTitle", { n: issueCount }))}</div>
    <ul class="recovery-status-lines">
      ${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
    </ul>
    ${details.length ? `<div class="recovery-status-details">${details.map((item) => `<code>${escapeHtml(item.path || item.error || "")}</code>`).join("")}</div>` : ""}
  `;
}

export function themeLabel(theme: unknown): string {
  const labels: Record<ThemeName, string> = {
    familiar: "toast.themeFamiliar",
    "alternative-familiar": "toast.themeAlternativeFamiliar",
    "classic-auto": "toast.themeClassicAuto",
    "classic-light": "toast.themeClassicLight",
    "classic-dark": "toast.themeClassicDark"
  };
  return t(labels[normalizeTheme(theme)]);
}

function renderSelectedWordPanelSettings(): void {
  if (!els.prefSelectedWordPanelItems) return;
  const items = normalizeSelectedWordPanelItems(state.preferences.selectedWordPanelItems);
  els.prefSelectedWordPanelItems.innerHTML = items.map((item, index) => {
    const label = t(`settings.wordPanelItems.${item.id}`);
    const visibleLabel = t("settings.wordPanelItemVisible", { item: label });
    const moveUpLabel = t("settings.wordPanelMoveUpAria", { item: label });
    const moveDownLabel = t("settings.wordPanelMoveDownAria", { item: label });
    return `
      <li class="word-panel-item-row" data-word-panel-setting-item="${item.id}">
        <label class="word-panel-item-visibility">
          <input type="checkbox" data-word-panel-item-visible="${item.id}" ${item.visible ? "checked" : ""} aria-label="${escapeAttribute(visibleLabel)}">
          <span>${escapeHtml(label)}</span>
        </label>
        <span class="word-panel-item-order-actions">
          <button class="secondary-button" type="button" data-word-panel-item-move="${item.id}" data-direction="up" ${index === 0 ? "disabled" : ""} title="${escapeAttribute(moveUpLabel)}" aria-label="${escapeAttribute(moveUpLabel)}">${escapeHtml(t("settings.wordPanelMoveUp"))}</button>
          <button class="secondary-button" type="button" data-word-panel-item-move="${item.id}" data-direction="down" ${index === items.length - 1 ? "disabled" : ""} title="${escapeAttribute(moveDownLabel)}" aria-label="${escapeAttribute(moveDownLabel)}">${escapeHtml(t("settings.wordPanelMoveDown"))}</button>
        </span>
      </li>
    `;
  }).join("");
}

export function applyPreferences(): Promise<void> {
  const prefs: Partial<WhPreferences> = state.preferences || {};
  const theme = normalizeTheme(prefs.theme);
  if (prefs.theme !== theme) prefs.theme = theme;
  const root = document.documentElement;
  const previousTheme = root.dataset.themePref;
  const previousMode = root.dataset.theme;
  const resolvedTheme = applyTheme(theme);
  if (byId<HTMLSelectElement>("pref-theme")) byId<HTMLSelectElement>("pref-theme").value = theme;

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
  const uiScalePromise = applyUiScale(uiScale);

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
  return uiScalePromise;
}

export function syncSettingsControls() {
  if (byId<HTMLSelectElement>("pref-theme")) byId<HTMLSelectElement>("pref-theme").value = normalizeTheme(state.preferences.theme);
  localeSelects().forEach((control) => { control.value = state.preferences.locale || "pl"; });
  learningLanguageSelects().forEach((control) => { control.value = state.preferences.learningLanguage || "en"; });

  const setFlagImages = (kind: string, lang: string, supported: readonly string[], fallback: string): string => {
    const flagKey = supported.includes(lang) ? lang : fallback;
    document.querySelectorAll<HTMLImageElement>(`[data-language-flag="${kind}"]`).forEach((img) => {
      img.src = `flags/${flagKey}.svg`;
      img.alt = t(`languages.${flagKey}`);
    });
    return flagKey;
  };

  const locale = state.preferences.locale || "pl";
  const appFlagKey = setFlagImages("locale", locale, APP_LOCALES, "pl");
  const appFlagEl = document.getElementById("app-lang-flag");
  if (appFlagEl) {
    appFlagEl.innerHTML = `<img src="flags/${appFlagKey}.svg" alt="${escapeHtml(t(`languages.${appFlagKey}`))}" class="cover-thumb-block">`;
  }

  const lang = state.preferences.learningLanguage || "en";
  const learnFlagKey = setFlagImages("learning", lang, LEARNING_LANGUAGES, "en");
  const learnFlagEl = document.getElementById("learning-lang-flag");
  if (learnFlagEl) {
    learnFlagEl.innerHTML = `<img src="flags/${learnFlagKey}.svg" alt="${escapeHtml(t(`languages.${learnFlagKey}`))}" class="cover-thumb-block">`;
  }

  const prefs: Partial<WhPreferences> = state.preferences || {};
  const translationPair = resolveProfileTranslationPair(prefs);
  if (els.prefTranslationLanguageSettings) els.prefTranslationLanguageSettings.hidden = lang !== OTHER_PROFILE_ID;
  if (els.prefTranslationSourceLanguage) els.prefTranslationSourceLanguage.value = prefs.translationSourceLanguage || "";
  if (els.prefTranslationTargetLanguage) els.prefTranslationTargetLanguage.value = prefs.translationTargetLanguage || translationPair.toCode;
  if (els.prefDictionaryUrl) els.prefDictionaryUrl.value = prefs.dictionaryUrl || "";
  if (els.prefDictionaryMode) els.prefDictionaryMode.value = prefs.dictionaryMode || "internal";
  if (els.prefYouglishMode) els.prefYouglishMode.value = prefs.youglishMode || "internal";
  const prefFont = byId<HTMLSelectElement>("pref-font");
  if (prefFont) prefFont.value = prefs.readerFont || "serif";
  const prefLineHeight = byId<HTMLSelectElement>("pref-line-height");
  if (prefLineHeight) prefLineHeight.value = prefs.readerLineHeight || "normal";
  if (els.prefTextAlign) els.prefTextAlign.value = prefs.readerTextAlign || "left";
  if (els.prefMaxWidth) els.prefMaxWidth.value = prefs.readerMaxWidth || "wide";
  if (els.prefReaderFocusMode) els.prefReaderFocusMode.checked = prefs.readerFocusMode === true;
  if (els.prefReaderWordPanelVisible) els.prefReaderWordPanelVisible.checked = prefs.readerWordPanelVisible !== false;
  renderSelectedWordPanelSettings();
  if (els.readerWordPanelToggle) {
    const visible = prefs.readerWordPanelVisible !== false;
    els.readerWordPanelToggle.setAttribute("aria-pressed", String(visible));
    els.readerWordPanelToggle.textContent = t(visible ? "settings.readerWordPanelHideControl" : "settings.readerWordPanelShowControl");
  }
  if (els.prefWordsPerPage) els.prefWordsPerPage.value = String(prefs.wordsPerPage || "1000");
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.value = prefs.wordDetectionAlgorithm || "modern";
  if (byId<HTMLSelectElement>("pref-srs-algorithm")) byId<HTMLSelectElement>("pref-srs-algorithm").value = prefs.srsAlgorithm === "sm2" ? "sm2" : "fsrs";
  if (els.prefTtsRate) els.prefTtsRate.value = prefs.ttsRate || "normal";
  if (els.prefAutoTtsOnWordFocus) els.prefAutoTtsOnWordFocus.checked = prefs.autoTtsOnWordFocus === true;
  if (byId<HTMLInputElement>("pref-auto-tts-on-flashcard-open")) byId<HTMLInputElement>("pref-auto-tts-on-flashcard-open").checked = prefs.autoTtsOnFlashcardOpen !== false;
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
  if (byId<HTMLSelectElement>("pref-removal-behavior")) byId<HTMLSelectElement>("pref-removal-behavior").value = prefs.removalBehavior || "ignored";
  if (els.ankiExportStatusFilters?.length) {
    const selected = Array.isArray(prefs.ankiExportStatuses) && prefs.ankiExportStatuses.length
      ? prefs.ankiExportStatuses
      : ["learning"];
    const selectedSet = new Set(selected);
    els.ankiExportStatusFilters.forEach((input) => {
      input.checked = selectedSet.has(input.value);
    });
  }
  const prefFontSize = byId<HTMLInputElement>("pref-font-size");
  if (prefFontSize) prefFontSize.value = String(state.readerFontSize || 18);
  if (els.prefFontSizeLabel) els.prefFontSizeLabel.textContent = t("settings.fontSize", { n: state.readerFontSize || 18 });
  if (els.readerFontSizeSlider) els.readerFontSizeSlider.value = String(state.readerFontSize || 18);
  if (els.readerFontSizeValue) els.readerFontSizeValue.textContent = `${state.readerFontSize || 18}px`;
  const uiScale = clamp(Math.round(Number(prefs.uiScale) || UI_SCALE.DEFAULT), UI_SCALE.MIN, UI_SCALE.MAX);
  if (byId<HTMLInputElement>("pref-ui-scale")) byId<HTMLInputElement>("pref-ui-scale").value = String(uiScale);
  if (byId<HTMLInputElement>("pref-ui-scale-label")) byId<HTMLInputElement>("pref-ui-scale-label").textContent = t("settings.uiScale", { n: uiScale });
  if (byId<HTMLInputElement>("pref-touch-controls")) byId<HTMLInputElement>("pref-touch-controls").checked = prefs.touchControls === true;
  const prefHighlight = byId<HTMLInputElement>("pref-highlight");
  if (prefHighlight) prefHighlight.checked = prefs.highlightTokens !== false;
  if (els.readerHighlightToggle) els.readerHighlightToggle.setAttribute("aria-pressed", String(prefs.highlightTokens !== false));
  if (els.prefHideKnown) els.prefHideKnown.checked = prefs.hideKnownIgnored === true;
  if (byId<HTMLInputElement>("pref-in-text-review")) byId<HTMLInputElement>("pref-in-text-review").checked = prefs.inTextReview === true;
  if (byId<HTMLInputElement>("pref-dynamic-learning-colors")) byId<HTMLInputElement>("pref-dynamic-learning-colors").checked = prefs.dynamicLearningColors === true;
  if (learningColorInputs().length) {
    const colors = normalizeLearningColors(prefs.learningColors);
    learningColorInputs().forEach((input, index) => {
      input.value = colors[index];
      input.title = t("settings.learningColorLevel", { n: index + 1 });
      input.setAttribute("aria-label", input.title);
    });
  }
  if (byId<HTMLElement>("pref-learning-colors-row")) byId<HTMLElement>("pref-learning-colors-row").hidden = prefs.dynamicLearningColors !== true;
  if (byId<HTMLSelectElement>("pref-review-graph-type")) byId<HTMLSelectElement>("pref-review-graph-type").value = prefs.reviewGraphType || "heatmap";
  const prefAutoLearn = byId<HTMLInputElement>("pref-auto-learn");
  if (prefAutoLearn) prefAutoLearn.checked = prefs.autoLearnOnClick === true;
  if (byId<HTMLInputElement>("pref-auto-add-learning")) byId<HTMLInputElement>("pref-auto-add-learning").checked = prefs.autoAddLearningOnly === true;
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
  const aiEnabled = prefs.aiExplanationsEnabled === true;
  if (byId<HTMLInputElement>("pref-ai-explanations")) byId<HTMLInputElement>("pref-ai-explanations").checked = aiEnabled;
  if (byId<HTMLInputElement>("pref-ai-endpoint")) byId<HTMLInputElement>("pref-ai-endpoint").value = prefs.aiExplanationEndpoint || DEFAULT_AI_ENDPOINT;
  if (byId<HTMLInputElement>("pref-ai-model")) byId<HTMLInputElement>("pref-ai-model").value = prefs.aiExplanationModel || DEFAULT_AI_MODEL;
  if (byId<HTMLInputElement>("pref-ai-api-key")) byId<HTMLInputElement>("pref-ai-api-key").value = prefs.aiExplanationApiKey || "";
  if (byId<HTMLSelectElement>("pref-ai-effort")) byId<HTMLSelectElement>("pref-ai-effort").value = normalizeAiTextPreference("aiExplanationEffort", prefs.aiExplanationEffort);
  if (byId<HTMLInputElement>("pref-ai-auto-trigger")) byId<HTMLInputElement>("pref-ai-auto-trigger").checked = prefs.aiExplanationAutoTrigger === true;
  if (byId<HTMLInputElement>("pref-ai-endpoint-row")) byId<HTMLInputElement>("pref-ai-endpoint-row").hidden = !aiEnabled;
  if (byId<HTMLInputElement>("pref-ai-model-row")) byId<HTMLInputElement>("pref-ai-model-row").hidden = !aiEnabled;
  if (byId<HTMLInputElement>("pref-ai-key-row")) byId<HTMLInputElement>("pref-ai-key-row").hidden = !aiEnabled;
  if (byId<HTMLSelectElement>("pref-ai-effort-row")) byId<HTMLSelectElement>("pref-ai-effort-row").hidden = !aiEnabled;
  if (byId<HTMLInputElement>("pref-ai-auto-trigger-row")) byId<HTMLInputElement>("pref-ai-auto-trigger-row").hidden = !aiEnabled;
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
  if (byId<HTMLInputElement>("pref-card-stats")) byId<HTMLInputElement>("pref-card-stats").checked = prefs.showCardStats !== false;
  if (byId<HTMLInputElement>("pref-card-stats-mode")) byId<HTMLInputElement>("pref-card-stats-mode").value = ["percentages", "counts", "both"].includes(prefs.cardStatsMode) ? prefs.cardStatsMode : "percentages";
  if (byId<HTMLInputElement>("pref-card-stats-mode-row")) {
    const enabled = prefs.showCardStats !== false;
    byId<HTMLInputElement>("pref-card-stats-mode-row").style.opacity = enabled ? "1" : "0.5";
    byId<HTMLInputElement>("pref-card-stats-mode-row").setAttribute("aria-disabled", String(!enabled));
    if (byId<HTMLInputElement>("pref-card-stats-mode")) byId<HTMLInputElement>("pref-card-stats-mode").disabled = !enabled;
  }
  if (byId<HTMLInputElement>("pref-covers")) byId<HTMLInputElement>("pref-covers").checked = prefs.showCovers !== false;
  if (els.prefUseEdgeTts) els.prefUseEdgeTts.checked = prefs.useEdgeTts === true;

  if (byId<HTMLInputElement>("pref-color-new")) byId<HTMLInputElement>("pref-color-new").value = prefs.colorNew || "#ff6b6b";
  if (byId<HTMLInputElement>("pref-color-learning")) byId<HTMLInputElement>("pref-color-learning").value = prefs.colorLearning || "#ffb84d";
  if (byId<HTMLInputElement>("pref-color-known")) byId<HTMLInputElement>("pref-color-known").value = prefs.colorKnown || "#8ce99a";
  if (byId<HTMLInputElement>("pref-color-ignored")) byId<HTMLInputElement>("pref-color-ignored").value = prefs.colorIgnored || "#ced4da";
  if (byId<HTMLElement>("storage-summary") && state.currentView === "settings") {
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      const kb = (bytes / 1024).toFixed(1);
      let summary = t("settings.storageSummary", {
        words: Object.keys(state.vocab).length,
        texts: state.customTexts.length,
        kb
      });
      byId<HTMLElement>("storage-summary").textContent = summary;
    } catch (error) {
      console.warn(error);
    }
  }
  if (byId<HTMLElement>("data-directory")) {
    byId<HTMLElement>("data-directory").textContent = state.dataDirectory
      ? t("settings.dataFolderPath", { path: state.dataDirectory })
      : t("settings.dataFolderDefault");
  }
  renderRecoveryStatus();
}

export function updatePreferenceValue(key: string, value: unknown): void {
  state.preferences[key] = value;
  if (["dictionaryUrl", "dictionaryMode", "youglishMode", "translationSourceLanguage", "translationTargetLanguage"].includes(key)) {
    const profile = state.profiles?.[state.preferences.learningLanguage];
    if (profile) {
      profile.preferences = profile.preferences || {};
      profile.preferences[key] = value;
    }
    if (key === "translationSourceLanguage" && state.preferences.learningLanguage === OTHER_PROFILE_ID) {
      rekeyActiveVocabForLocale(OTHER_PROFILE_ID, state);
    }
  }
  saveState();
  applyPreferences();
}

export function resetPreferences() {
  const defaults = createDefaultState();
  const lastReadTextIds = state.preferences?.lastReadTextIds || {};
  const readerBookmarks = state.preferences?.readerBookmarks || {};
  const learningLanguage = state.preferences?.learningLanguage || defaults.preferences.learningLanguage;
  const profilePreferences = state.profiles?.[learningLanguage]?.preferences || {};
  state.preferences = {
    ...defaults.preferences,
    learningLanguage,
    dictionaryUrl: profilePreferences.dictionaryUrl || getDefaultDictionaryUrl(learningLanguage),
    dictionaryMode: profilePreferences.dictionaryMode || "internal",
    youglishMode: profilePreferences.youglishMode || "internal",
    translationSourceLanguage: profilePreferences.translationSourceLanguage || "",
    translationTargetLanguage: profilePreferences.translationTargetLanguage || (learningLanguage === OTHER_PROFILE_ID ? state.preferences.locale || "en" : ""),
    lastReadTextIds,
    readerBookmarks
  };
  if (state.profiles?.[learningLanguage]) {
    state.profiles[learningLanguage].preferences = {
      ...(state.profiles[learningLanguage].preferences || {}),
      dictionaryUrl: state.preferences.dictionaryUrl,
      dictionaryMode: state.preferences.dictionaryMode,
      youglishMode: state.preferences.youglishMode,
      translationSourceLanguage: state.preferences.translationSourceLanguage,
      translationTargetLanguage: state.preferences.translationTargetLanguage,
    };
  }
  state.readerFontSize = defaults.readerFontSize;
  saveState();
  applyPreferences();
  syncSettingsControls();
}

export function setReaderFontSize(value: unknown): void {
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

export function setUiScale(value: unknown): number {
  const stepped = Math.round(Number(value) / UI_SCALE.STEP) * UI_SCALE.STEP;
  const clamped = clamp(stepped || UI_SCALE.DEFAULT, UI_SCALE.MIN, UI_SCALE.MAX);
  state.preferences.uiScale = clamped;
  saveState();
  applyPreferences();
  if (byId<HTMLInputElement>("pref-ui-scale")) byId<HTMLInputElement>("pref-ui-scale").value = String(clamped);
  if (byId<HTMLInputElement>("pref-ui-scale-label")) byId<HTMLInputElement>("pref-ui-scale-label").textContent = t("settings.uiScale", { n: clamped });
  return clamped;
}
