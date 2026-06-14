// User preferences: theme, font, size — reads and saves state, updates DOM.
import { state, saveState, createDefaultState } from "./state.js";
import { FONT_STACKS, LINE_HEIGHTS } from "./constants.js";
import { els } from "./dom.js";
import { clamp, escapeHtml } from "./utils.js";
import { t } from "./i18n.js";

export function themeLabel(theme) {
  if (theme === "dark") return t("toast.themeDark");
  if (theme === "light") return t("toast.themeLight");
  return t("toast.themeAuto");
}

export function applyPreferences() {
  const prefs = state.preferences || {};
  const theme = prefs.theme || "auto";
  const resolved = theme === "auto"
    ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = theme;

  const fontKey = FONT_STACKS[prefs.readerFont] ? prefs.readerFont : "serif";
  const lineKey = LINE_HEIGHTS[prefs.readerLineHeight] ? prefs.readerLineHeight : "normal";
  document.documentElement.style.setProperty("--reader-font-family", FONT_STACKS[fontKey]);
  document.documentElement.style.setProperty("--reader-line-height", String(LINE_HEIGHTS[lineKey]));
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  document.documentElement.dataset.textAlign = prefs.readerTextAlign || "left";
  document.documentElement.dataset.maxWidth = prefs.readerMaxWidth || "medium";
  document.documentElement.style.setProperty("--token-new-bg", prefs.colorNew || "#ff6b6b");
  document.documentElement.style.setProperty("--token-learning-bg", prefs.colorLearning || "#ffb84d");
  document.documentElement.style.setProperty("--token-known-bg", prefs.colorKnown || "#8ce99a");
  document.documentElement.style.setProperty("--token-ignored-bg", prefs.colorIgnored || "#ced4da");
  document.documentElement.classList.toggle("no-token-highlight", prefs.highlightTokens === false);
  document.documentElement.classList.toggle("no-highlight-known-ignored", prefs.hideKnownIgnored === true);
  document.documentElement.classList.toggle("no-card-stats", prefs.showCardStats === false);
  document.documentElement.classList.toggle("no-covers", prefs.showCovers === false);

  if (els.themeToggle) {
    const glyph = theme === "dark" ? "☀" : theme === "light" ? "☽" : "◑";
    els.themeToggle.textContent = glyph;
    els.themeToggle.title = t("toast.themeChanged", { name: themeLabel(theme) });
  }
}

export function syncSettingsControls() {
  if (els.prefTheme) els.prefTheme.value = state.preferences.theme || "auto";
  if (els.prefLocale) els.prefLocale.value = state.preferences.locale || "pl";
  if (els.prefLearningLanguage) els.prefLearningLanguage.value = state.preferences.learningLanguage || "en";
  
  const appFlagEl = document.getElementById("app-lang-flag");
  if (appFlagEl) {
    const locale = state.preferences.locale || "pl";
    const supportedAppFlags = ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"];
    const flagKey = supportedAppFlags.includes(locale) ? locale : "pl";
    appFlagEl.innerHTML = `<img src="flags/${flagKey}.svg" alt="${escapeHtml(t(`languages.${flagKey}`))}" style="width: 1.5rem; height: 1.5rem; border-radius: 4px; object-fit: cover; flex-shrink: 0; display: block; pointer-events: none;">`;
  }

  const learnFlagEl = document.getElementById("learning-lang-flag");
  if (learnFlagEl) {
    const lang = state.preferences.learningLanguage || "en";
    const supportedFlags = ["en", "de", "es", "it", "fr", "pl", "uk", "ru", "ja"];
    const flagKey = supportedFlags.includes(lang) ? lang : "en";
    learnFlagEl.innerHTML = `<img src="flags/${flagKey}.svg" alt="${escapeHtml(t(`languages.${flagKey}`))}" style="width: 1.5rem; height: 1.5rem; border-radius: 4px; object-fit: cover; flex-shrink: 0; display: block; pointer-events: none;">`;
  }

  const prefs = state.preferences || {};
  if (els.prefDictionaryUrl) els.prefDictionaryUrl.value = prefs.dictionaryUrl || "";
  if (els.prefDictionaryMode) els.prefDictionaryMode.value = prefs.dictionaryMode || "internal";
  els.prefFont.value = prefs.readerFont || "serif";
  els.prefLineHeight.value = prefs.readerLineHeight || "normal";
  if (els.prefTextAlign) els.prefTextAlign.value = prefs.readerTextAlign || "left";
  if (els.prefMaxWidth) els.prefMaxWidth.value = prefs.readerMaxWidth || "medium";
  if (els.prefWordsPerPage) els.prefWordsPerPage.value = prefs.wordsPerPage || "1000";
  if (els.prefWordAlgorithm) els.prefWordAlgorithm.value = prefs.wordDetectionAlgorithm || "modern";
  if (els.prefSrsAlgorithm) els.prefSrsAlgorithm.value = prefs.srsAlgorithm === "fsrs" ? "fsrs" : "sm2";
  if (els.prefTtsRate) els.prefTtsRate.value = prefs.ttsRate || "normal";
  if (els.prefAutoTtsOnWordFocus) els.prefAutoTtsOnWordFocus.checked = prefs.autoTtsOnWordFocus === true;
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
  els.prefHighlight.checked = prefs.highlightTokens !== false;
  if (els.prefHideKnown) els.prefHideKnown.checked = prefs.hideKnownIgnored === true;
  if (els.prefReviewGraphType) els.prefReviewGraphType.value = prefs.reviewGraphType || "heatmap";
  els.prefAutoLearn.checked = prefs.autoLearnOnClick === true;
  if (els.prefAutoAddLearning) els.prefAutoAddLearning.checked = prefs.autoAddLearningOnly === true;
  if (els.prefAutoTranslate) els.prefAutoTranslate.checked = prefs.autoTranslateWords === true;
  if (els.prefAutoTranslateRow) {
    const enabled = prefs.offlineTranslator === true;
    els.prefAutoTranslateRow.style.opacity = enabled ? "1" : "0.5";
    els.prefAutoTranslateRow.style.pointerEvents = enabled ? "auto" : "none";
  }
  if (els.prefOfflineTranslator) els.prefOfflineTranslator.checked = prefs.offlineTranslator === true;
  if (els.prefArgosAsDict) {
    els.prefArgosAsDict.checked = prefs.argosAsDict === true;
    if (els.prefArgosAsDictRow) {
      const enabled = prefs.offlineTranslator === true;
      els.prefArgosAsDictRow.style.opacity = enabled ? "1" : "0.5";
      els.prefArgosAsDictRow.style.pointerEvents = enabled ? "auto" : "none";
    }
  }
  els.prefCardStats.checked = prefs.showCardStats !== false;
  if (els.prefCovers) els.prefCovers.checked = prefs.showCovers !== false;
  if (els.prefUseEdgeTts) els.prefUseEdgeTts.checked = prefs.useEdgeTts === true;

  if (els.prefColorNew) els.prefColorNew.value = prefs.colorNew || "#ff6b6b";
  if (els.prefColorLearning) els.prefColorLearning.value = prefs.colorLearning || "#ffb84d";
  if (els.prefColorKnown) els.prefColorKnown.value = prefs.colorKnown || "#8ce99a";
  if (els.prefColorIgnored) els.prefColorIgnored.value = prefs.colorIgnored || "#ced4da";
  if (els.storageSummary) {
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      const kb = (bytes / 1024).toFixed(1);
      els.storageSummary.textContent = t("settings.storageSummary", {
        words: Object.keys(state.vocab).length,
        texts: state.customTexts.length,
        kb
      });
    } catch (error) {
      console.warn(error);
    }
  }
}

export function updatePreferenceValue(key, value) {
  state.preferences[key] = value;
  saveState();
  applyPreferences();
}

export function resetPreferences() {
  const defaults = createDefaultState();
  const lastReadTextIds = state.preferences?.lastReadTextIds || {};
  state.preferences = { ...defaults.preferences, lastReadTextIds };
  state.readerFontSize = defaults.readerFontSize;
  saveState();
  applyPreferences();
  syncSettingsControls();
}

export function setReaderFontSize(value) {
  state.readerFontSize = clamp(Number(value) || 18, 14, 28);
  saveState();
  applyPreferences();
  if (els.prefFontSizeLabel) els.prefFontSizeLabel.textContent = t("settings.fontSize", { n: state.readerFontSize });
  if (els.prefFontSize) els.prefFontSize.value = String(state.readerFontSize);
}
