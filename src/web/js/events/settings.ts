import { applyBridgeSnapshotToState, flushAllPendingFrontendState, getDurableStateRevision, runExclusiveStateWrite, state, saveState } from "../state.js";
import { els } from "../dom.js";
import { t, loadLocale, applyTranslations } from "../i18n.js";
import { render } from "../render.js";
import { refreshAddWordDialogLocalization } from "./word-editor.js";
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
import {
  countAiModelMatches,
  filterAiModels,
  getCachedAiModels,
  isAiModelCommitKey,
  isAiModelCacheFresh,
  requestAiModels
} from "../ai-model-discovery.js";
import { normalizeSelectedWordPanelItems } from "../state/normalize.js";
import { remapReaderBookmarksForAlgorithm } from "../reader/bookmarks.js";

type ApplyBridgeSnapshotOptions = {
  expectedRevision?: number;
  preserveActiveReader?: boolean;
};

let wordAlgorithmChangeGeneration = 0;

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let aiModelsLoading = false;
let aiModelsAbortController: AbortController | null = null;
let availableAiModels: string[] = [];
let activeAiModelOption = -1;

function aiModelElements() {
  return {
    endpoint: byId<HTMLInputElement>("pref-ai-endpoint"),
    apiKey: byId<HTMLInputElement>("pref-ai-api-key"),
    model: byId<HTMLInputElement>("pref-ai-model"),
    search: byId<HTMLInputElement>("pref-ai-model-search"),
    refresh: byId<HTMLButtonElement>("pref-ai-model-refresh"),
    status: byId<HTMLElement>("pref-ai-model-status"),
    options: byId<HTMLElement>("pref-ai-model-options")
  };
}

function cancelAiModelRefresh() {
  aiModelsAbortController?.abort();
  aiModelsAbortController = null;
  aiModelsLoading = false;
  const { refresh } = aiModelElements();
  if (refresh) refresh.disabled = false;
}

function closeAiModelOptions() {
  const { search, options } = aiModelElements();
  if (options) options.hidden = true;
  if (search) {
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  }
  activeAiModelOption = -1;
}

function setActiveAiModelOption(index: number) {
  const { search, options } = aiModelElements();
  if (!search || !options) return;
  const buttons = [...options.querySelectorAll<HTMLButtonElement>(".ai-model-option")];
  if (!buttons.length) return;
  activeAiModelOption = Math.max(0, Math.min(index, buttons.length - 1));
  buttons.forEach((button, buttonIndex) => {
    const active = buttonIndex === activeAiModelOption;
    button.classList.toggle("active", active);
  });
  const active = buttons[activeAiModelOption];
  search.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}

function renderAiModelOptions(open = true, updateStatus = true) {
  const { model, search, status, options } = aiModelElements();
  if (!model || !search || !status || !options) return;
  options.replaceChildren();
  activeAiModelOption = -1;
  search.removeAttribute("aria-activedescendant");
  if (!open) {
    closeAiModelOptions();
    return;
  }
  const matches = filterAiModels(availableAiModels, search.value);
  if (!availableAiModels.length) {
    closeAiModelOptions();
    return;
  }
  if (!matches.length) {
    status.textContent = t("settings.aiModelsNoResults");
    closeAiModelOptions();
    return;
  }
  for (const [index, modelId] of matches.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `pref-ai-model-option-${index}`;
    option.className = "ai-model-option";
    option.tabIndex = -1;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(modelId === model.value.trim()));
    option.dataset.modelId = modelId;
    option.textContent = modelId;
    options.appendChild(option);
  }
  options.hidden = false;
  search.setAttribute("aria-expanded", "true");
  if (updateStatus) {
    status.textContent = t("settings.aiModelsMatches", {
      n: countAiModelMatches(availableAiModels, search.value)
    });
  }
}

function showCachedAiModels(open = false) {
  const controls = aiModelElements();
  const endpoint = controls.endpoint?.value.trim() || "";
  availableAiModels = getCachedAiModels(state.preferences.aiExplanationModelsCache, endpoint);
  if (controls.status) {
    controls.status.textContent = availableAiModels.length
      ? t("settings.aiModelsLoaded", { n: availableAiModels.length })
      : "";
  }
  renderAiModelOptions(open, open);
}

async function refreshAiModels(force = false) {
  const controls = aiModelElements();
  if (!controls.endpoint || !controls.apiKey || !controls.status || !controls.refresh) return;
  if (force && aiModelsAbortController) {
    cancelAiModelRefresh();
  } else if (aiModelsLoading) {
    return;
  }
  const endpoint = controls.endpoint.value.trim();
  if (!endpoint) {
    controls.status.textContent = t("settings.aiModelsError");
    closeAiModelOptions();
    return;
  }
  const cache = state.preferences.aiExplanationModelsCache;
  availableAiModels = getCachedAiModels(cache, endpoint);
  renderAiModelOptions(controls.search === document.activeElement);
  if (!force && isAiModelCacheFresh(cache, endpoint)) {
    controls.status.textContent = t("settings.aiModelsLoaded", { n: availableAiModels.length });
    return;
  }

  const requestController = new AbortController();
  aiModelsAbortController = requestController;
  aiModelsLoading = true;
  controls.refresh.disabled = true;
  controls.status.textContent = t("settings.aiModelsLoading");
  try {
    const models = await requestAiModels(endpoint, controls.apiKey.value, requestController.signal);
    if (aiModelsAbortController !== requestController) return;
    if (!models.length) throw new Error("AI model catalog is empty");
    availableAiModels = models;
    state.preferences.aiExplanationModelsCache = {
      endpoint,
      models,
      fetchedAt: Date.now()
    };
    await saveState();
    controls.status.textContent = t("settings.aiModelsLoaded", { n: models.length });
    renderAiModelOptions(controls.search === document.activeElement, false);
  } catch (error) {
    if (requestController.signal.aborted || aiModelsAbortController !== requestController) return;
    console.warn("AI model discovery failed", error instanceof Error ? error.message : error);
    controls.status.textContent = availableAiModels.length
      ? t("settings.aiModelsCached", { n: availableAiModels.length })
      : t("settings.aiModelsError");
    renderAiModelOptions(controls.search === document.activeElement, false);
  } finally {
    if (aiModelsAbortController === requestController) {
      aiModelsAbortController = null;
      aiModelsLoading = false;
      controls.refresh.disabled = false;
    }
  }
}

function bindAiModelPicker() {
  const controls = aiModelElements();
  if (!controls.model || !controls.search || !controls.refresh || !controls.options) return;

  controls.search.addEventListener("focus", () => {
    showCachedAiModels(true);
  });
  controls.search.addEventListener("input", () => renderAiModelOptions());
  controls.search.addEventListener("keydown", (event) => {
    const count = controls.options?.querySelectorAll(".ai-model-option").length || 0;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActiveAiModelOption(activeAiModelOption + 1);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActiveAiModelOption(activeAiModelOption < 0 ? count - 1 : activeAiModelOption - 1);
    } else if (isAiModelCommitKey(event) && count) {
      event.preventDefault();
      const selectedIndex = activeAiModelOption < 0 ? 0 : activeAiModelOption;
      controls.options?.querySelectorAll<HTMLButtonElement>(".ai-model-option")[selectedIndex]?.click();
    } else if (event.key === "Escape") {
      closeAiModelOptions();
    }
  });
  controls.search.addEventListener("search", () => {
    const options = controls.options?.querySelectorAll<HTMLButtonElement>(".ai-model-option");
    const selectedIndex = activeAiModelOption < 0 ? 0 : activeAiModelOption;
    options?.[selectedIndex]?.click();
  });
  controls.options.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>(".ai-model-option");
    const modelId = option?.dataset.modelId;
    if (!modelId) return;
    controls.model!.value = modelId;
    controls.search!.value = "";
    void updatePreferenceValue("aiExplanationModel", modelId);
    closeAiModelOptions();
    controls.model!.focus();
  });
  controls.refresh.addEventListener("click", () => void refreshAiModels(true));
  document.addEventListener("pointerdown", (event) => {
    const row = byId("pref-ai-model-row");
    if (row && !row.contains(event.target as Node)) closeAiModelOptions();
  });
  window.addEventListener("wordhunter:view-changed", (event) => {
    const view = (event as CustomEvent<{ view?: string }>).detail?.view;
    if (view !== "settings") {
      cancelAiModelRefresh();
      closeAiModelOptions();
      return;
    }
    if (state.preferences.aiExplanationsEnabled) {
      showCachedAiModels(false);
    }
  });
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


/**
 * Builds the Settings view shell and the phase-1 general panels (Appearance,
 * Flashcards, AI explanations, Local data) once (idempotent). Called during
 * app boot before cacheElements() (app.ts); every consumer resolves the
 * elements via getElementById after boot, so boot order guarantees they
 * exist. The Reader and Translator & Dictionary panels stay static in
 * index.html for phase 2 of the #127 P3 port.
 */
export function renderSettingsView(): HTMLElement {
  const existing = document.getElementById("settings-view");
  if (existing instanceof HTMLElement) return existing;
  if (existing) throw new TypeError("#settings-view must be an element");

  const view = document.createElement("section");
  view.id = "settings-view";
  view.className = "view";
  view.setAttribute("data-title-key", "nav.settings");
  view.innerHTML = `
        <div class="settings-grid">
          <section class="panel" aria-labelledby="appearance-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.appearanceEyebrow">Appearance</p>
              <h2 id="appearance-heading" data-i18n="settings.appearanceHeading">Theme and interface</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupLanguage">Language and interface</p>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.theme">Theme</span>
                  <small data-i18n="settings.themeHint">The theme is shared by all learning languages. Familiar themes stay dark on desktop and follow the system mode on Pocket.</small>
                </span>
                <select id="pref-theme" data-pref="theme">
                  <option value="familiar" data-i18n="settings.themeFamiliar">Familiar (cool blue)</option>
                  <option value="alternative-familiar" data-i18n="settings.themeAlternativeFamiliar">Alternative familiar (aubergine and orange)</option>
                  <option value="classic-auto" data-i18n="settings.themeClassicAuto">Word Hunter Classic (system)</option>
                  <option value="classic-light" data-i18n="settings.themeClassicLight">Word Hunter Classic (light)</option>
                  <option value="classic-dark" data-i18n="settings.themeClassicDark">Word Hunter Classic (dark)</option>
                </select>
              </label>
              <label class="setting-row language-setting-row">
                <span class="language-setting-title" data-i18n="settings.interfaceLanguageTitle">App interface language</span>
                <span class="language-select-wrap">
                  <img class="language-select-flag" data-language-flag="locale" src="flags/en.svg" alt="" aria-hidden="true">
                  <select id="pref-locale-settings" aria-label="App interface language" data-i18n-attr="aria-label=settings.interfaceLanguageTitle">
                    <option value="pl" data-i18n="languages.pl">Polish</option>
                    <option value="en" data-i18n="languages.en">English</option>
                    <option value="de" data-i18n="languages.de">German</option>
                    <option value="es" data-i18n="languages.es">Spanish</option>
                    <option value="fr" data-i18n="languages.fr">French</option>
                    <option value="it" data-i18n="languages.it">Italian</option>
                    <option value="uk" data-i18n="languages.uk">Українська</option>
                    <option value="ru" data-i18n="languages.ru">Muscovite State</option>
                    <option value="ja" data-i18n="languages.ja">Japanese</option>
                    <option value="zh" data-i18n="languages.zh">Chinese (Simplified)</option>
                  </select>
                </span>
              </label>
              <label class="setting-row language-setting-row">
                <span class="language-setting-title" data-i18n="settings.learningLanguageTitle">Learning language (profile)</span>
                <span class="language-select-wrap">
                  <img class="language-select-flag" data-language-flag="learning" src="flags/de.svg" alt="" aria-hidden="true">
                  <select id="pref-learning-language-settings" aria-label="Learning language (profile)" data-i18n-attr="aria-label=settings.learningLanguageTitle">
                    <option value="en" data-i18n="languages.en">English</option>
                    <option value="de" data-i18n="languages.de">German</option>
                    <option value="es" data-i18n="languages.es">Spanish</option>
                    <option value="it" data-i18n="languages.it">Italian</option>
                    <option value="fr" data-i18n="languages.fr">French</option>
                    <option value="pl" data-i18n="languages.pl">Polish</option>
                    <option value="uk" data-i18n="languages.uk">Українська</option>
                    <option value="ru" data-i18n="languages.ru">Muscovite State</option>
                    <option value="ja" data-i18n="languages.ja">Japanese</option>
                    <option value="zh" data-i18n="languages.zh">Chinese (Simplified)</option>
                    <option value="la" data-i18n="languages.la">Latin</option>
                    <option value="grc" data-i18n="languages.grc">Ancient Greek</option>
                    <option value="other" data-i18n="languages.other">Other</option>
                  </select>
                </span>
              </label>
              <div class="setting-row pocket-only-setting">
                <span>
                  <span data-i18n="nav.help">Help</span>
                  <small data-i18n="help.tipsTitle">Useful Tips</small>
                </span>
                <button class="secondary-button" type="button" data-open-view="help" data-i18n="nav.help">Help</button>
              </div>
              <label class="setting-row desktop-only-setting">
                <span id="pref-ui-scale-label"></span>
                <input id="pref-ui-scale" type="range" min="80" max="150" step="5" aria-labelledby="pref-ui-scale-label">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.touchControls">Larger controls</span>
                  <small data-i18n="settings.touchControlsHint">On desktop, makes buttons and spacing roomier for touch screens, laptops, and tablets.</small>
                </span>
                <input id="pref-touch-controls" type="checkbox" data-pref="touchControls">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupLearningDisplay">Learning display</p>
              <label class="setting-row">
                <span data-i18n="settings.reviewGraphType">Flashcard chart</span>
                <select id="pref-review-graph-type">
                  <option value="heatmap" data-i18n="settings.reviewGraphHeatmap">Heatmap</option>
                  <option value="dueForecast" data-i18n="settings.reviewGraphDue">Due forecast (21 days)</option>
                  <option value="intervals" data-i18n="settings.reviewGraphIntervals">Intervals</option>
                  <option value="easeDistribution" data-i18n="settings.reviewGraphEase">Ease (EF)</option>
                  <option value="repetitions" data-i18n="settings.reviewGraphReps">Repetitions</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.statusColors">Status colors</span>
                <div class="color-pickers-group">
                  <input type="color" id="pref-color-new" class="color-picker-lg" data-i18n-attr="title=vocab.statusNew,aria-label=vocab.statusNew">
                  <input type="color" id="pref-color-learning" class="color-picker-lg" data-i18n-attr="title=vocab.statusLearning,aria-label=vocab.statusLearning">
                  <input type="color" id="pref-color-known" class="color-picker-lg" data-i18n-attr="title=vocab.statusKnown,aria-label=vocab.statusKnown">
                  <input type="color" id="pref-color-ignored" class="color-picker-lg" data-i18n-attr="title=vocab.statusIgnored,aria-label=vocab.statusIgnored">
                </div>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.dynamicLearningColors">Learning word color by SRS level</span>
                  <small data-i18n="settings.dynamicLearningColorsHint">Level 1 starts orange and level 5 ends green. Adjust the colors below.</small>
                </span>
                <input id="pref-dynamic-learning-colors" type="checkbox">
              </label>
              <div class="setting-row" id="pref-learning-colors-row" hidden>
                <span data-i18n="settings.learningColorPalette">Learning color palette (levels 1–5)</span>
                <div class="color-pickers-group">
                  <input type="color" class="color-picker-lg" data-learning-color="0">
                  <input type="color" class="color-picker-lg" data-learning-color="1">
                  <input type="color" class="color-picker-lg" data-learning-color="2">
                  <input type="color" class="color-picker-lg" data-learning-color="3">
                  <input type="color" class="color-picker-lg" data-learning-color="4">
                </div>
              </div>

              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.cardStats">Stats on book cards</span>
                  <small data-i18n="settings.cardStatsHint">Shows each book's reading progress and vocabulary count in the Library cards.</small>
                </span>
                <input id="pref-card-stats" type="checkbox">
              </label>
              <label class="setting-row" id="pref-card-stats-mode-row">
                <span>
                  <span data-i18n="settings.cardStatsMode">Book statistics values</span>
                  <small data-i18n="settings.cardStatsModeHint">Show percentages, exact occurrence counts, or both.</small>
                </span>
                <select id="pref-card-stats-mode">
                  <option value="percentages" data-i18n="settings.cardStatsModePercentages">Percentages</option>
                  <option value="counts" data-i18n="settings.cardStatsModeCounts">Counts</option>
                  <option value="both" data-i18n="settings.cardStatsModeBoth">Percentages and counts</option>
                </select>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.covers">Book Covers</span>
                  <small data-i18n="settings.coversHint">Shows book cover thumbnails when Gutenberg metadata provides one; books without covers stay text-only.</small>
                </span>
                <input id="pref-covers" type="checkbox">
              </label>
              <div class="setting-row desktop-only-setting">
                <span data-i18n="settings.ocrGpuAcceleration">OCR acceleration</span>
                <output id="ocr-gpu-status" aria-live="polite" data-i18n="settings.ocrGpuChecking">Checking…</output>
              </div>
            </div>
          </section>


          <!-- Phase 2 (#127 P3): Reader and Translator & Dictionary panels stay
               static in index.html until renderSettingsView() covers them. -->
          <section class="panel" aria-labelledby="reader-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.readerEyebrow">Reader</p>
              <h2 id="reader-prefs-heading" data-i18n="settings.readerHeading">Typography and behaviour</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupReader">Reader layout</p>
              <label class="setting-row">
                <span data-i18n="settings.font">Reader font</span>
                <select id="pref-font" data-pref="readerFont">
                  <option value="serif" data-i18n="settings.fontSerif">Serif (Georgia)</option>
                  <option value="sans" data-i18n="settings.fontSans">Sans-serif (Segoe UI)</option>
                  <option value="mono" data-i18n="settings.fontMono">Monospace (mono)</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.lineHeight">Line height</span>
                <select id="pref-line-height" data-pref="readerLineHeight">
                  <option value="compact" data-i18n="settings.lineCompact">Compact</option>
                  <option value="normal" data-i18n="settings.lineNormal">Normal</option>
                  <option value="loose" data-i18n="settings.lineLoose">Loose</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.textAlign">Text alignment</span>
                <select id="pref-text-align" data-pref="readerTextAlign">
                  <option value="left" data-i18n="settings.alignLeft">Left</option>
                  <option value="justify" data-i18n="settings.alignJustify">Justified</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.maxWidth">Page width</span>
                <select id="pref-max-width" data-pref="readerMaxWidth">
                  <option value="narrow" data-i18n="settings.widthNarrow">Narrow</option>
                  <option value="medium" data-i18n="settings.widthMedium">Medium</option>
                  <option value="wide" data-i18n="settings.widthWide">Wide</option>
                  <option value="full" data-i18n="settings.widthFull">Full width</option>
                </select>
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.readerFocusMode">Reader focus mode</span>
                  <small data-i18n="settings.readerFocusModeHint">On desktop, hides the top bar, book metadata, and shortcut hints to leave more room for text.</small>
                </span>
                <input id="pref-reader-focus-mode" type="checkbox" data-pref="readerFocusMode">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.readerWordPanelVisible">Word panel</span>
                  <small data-i18n="settings.readerWordPanelVisibleHint">Lets you hide the right panel and read at full width when you do not need it.</small>
                </span>
                <input id="pref-reader-word-panel-visible" type="checkbox" data-pref="readerWordPanelVisible">
              </label>
              <details class="word-panel-items-setting">
                <summary id="word-panel-items-heading" class="settings-subheading" data-i18n="settings.wordPanelItemsHeading"></summary>
                <div class="word-panel-items-setting-body">
                  <p id="word-panel-items-hint" class="muted-copy" data-i18n="settings.wordPanelItemsHint"></p>
                  <ol id="pref-selected-word-panel-items" class="word-panel-item-list" aria-labelledby="word-panel-items-heading" aria-describedby="word-panel-items-hint"></ol>
                </div>
              </details>
              <label class="setting-row">
                <span data-i18n="settings.wordsPerPage">Words per page</span>
                <select id="pref-words-per-page">
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                  <option value="2000">2000</option>
                  <option value="5000">5000</option>
                  <option value="999999" data-i18n="settings.wordsAll">All</option>
                </select>
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.wordAlgorithm">Word recognition</span>
                  <small data-i18n="settings.wordAlgorithmHint">New detects languages without spaces and short subtitle lines better, for example Japanese or Chinese. Classic splits only letter runs, so it can be more predictable for simple texts.</small>
                </span>
                <select id="pref-word-algorithm">
                  <option value="modern" data-i18n="settings.wordAlgorithmModern">New (default)</option>
                  <option value="classic" data-i18n="settings.wordAlgorithmClassic">Classic</option>
                </select>
              </label>
              <label class="setting-row">
                <span id="pref-font-size-label"></span>
                <input id="pref-font-size" type="range" min="14" max="28" step="1" aria-labelledby="pref-font-size-label">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.highlight">Highlight word status in text</span>
                  <small data-i18n="settings.highlightHint">Underlines saved words in the reader using their learning-status colors. Turn off for plain text.</small>
                </span>
                <input id="pref-highlight" type="checkbox" data-pref="highlightTokens">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.hideKnownIgnored">Hide known and ignored</span>
                  <small data-i18n="settings.hideKnownIgnoredHint">Leaves known and ignored words unmarked, so only words that still need attention stand out.</small>
                </span>
                <input id="pref-hide-known" type="checkbox" data-pref="hideKnownIgnored">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoLearn">Auto-mark as “Learning”</span>
                  <small data-i18n="settings.autoLearnHint">First click on an unknown word immediately saves it as Learning instead of leaving it New.</small>
                </span>
                <input id="pref-auto-learn" type="checkbox" data-pref="autoLearnOnClick">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupFeedbackSounds">Feedback sounds</p>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.statusSounds">Feedback sounds</span>
                  <small data-i18n="settings.statusSoundsHint">Plays a short sound after rating a flashcard or changing a word status.</small>
                </span>
                <input id="pref-status-sounds-enabled" type="checkbox" data-pref="statusSoundsEnabled">
              </label>
              <label class="setting-row">
                <span id="pref-status-sound-volume-label" data-i18n="settings.statusSoundVolume">Feedback sound volume: {n}%</span>
                <input id="pref-status-sound-volume" type="range" min="0" max="100" step="5" data-pref="statusSoundVolume" aria-labelledby="pref-status-sound-volume-label">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupTts">Text to speech</p>
              <label class="setting-row">
                <span data-i18n="settings.ttsRate">TTS Speech Rate</span>
                <select id="pref-tts-rate" data-pref="ttsRate">
                  <option value="slow" data-i18n="settings.rateSlow">Slow</option>
                  <option value="normal" data-i18n="settings.rateNormal">Normal</option>
                  <option value="fast" data-i18n="settings.rateFast">Fast</option>
                </select>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoTtsOnWordFocus">Read word on focus</span>
                  <small data-i18n="settings.autoTtsOnWordFocusHint">Plays pronunciation whenever word focus changes by click or keyboard navigation.</small>
                </span>
                <input id="pref-auto-tts-on-word-focus" type="checkbox" data-pref="autoTtsOnWordFocus">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.ttsWordHighlight">Highlight spoken word</span>
                  <small data-i18n="settings.ttsWordHighlightHint">Shows a yellow outline on the word currently being read when the TTS engine reports word timing.</small>
                </span>
                <input id="pref-tts-word-highlight" type="checkbox" data-pref="ttsWordHighlight">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.useEdgeTts">Edge Neural TTS (online)</span>
                  <small data-i18n="settings.useEdgeTtsHint" class="muted-fw-400"></small>
                </span>
                <input id="pref-use-edge-tts" type="checkbox" data-pref="useEdgeTts">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="flashcard-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.flashcardEyebrow">Flashcards</p>
              <h2 id="flashcard-prefs-heading" data-i18n="settings.flashcardHeading">Reviews and algorithm</h2>
            </div>
            <div class="settings-body">
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoAddLearningOnly">Flashcards: only 'Learning' words</span>
                  <small data-i18n="settings.autoAddLearningOnlyHint">Only Learning words enter the review queue. New words stay out until you mark them Learning.</small>
                </span>
                <input id="pref-auto-add-learning" type="checkbox" data-pref="autoAddLearningOnly">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoTtsOnFlashcardOpen">Read new flashcards automatically</span>
                  <small data-i18n="settings.autoTtsOnFlashcardOpenHint">Plays pronunciation when you move to another word in Flashcards.</small>
                </span>
                <input id="pref-auto-tts-on-flashcard-open" type="checkbox" data-pref="autoTtsOnFlashcardOpen">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.inTextReview">Reviews while reading</span>
                  <small data-i18n="settings.inTextReviewHint">For Learning words, guess the translation first, then rate your recall from 1 to 5. (Reader review becomes available no sooner than the following day after first learning the word.)</small>
                </span>
                <input id="pref-in-text-review" type="checkbox">
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.srsAlgorithm">Flashcard algorithm</span>
                  <small data-i18n="settings.srsAlgorithmHint">SM-2 schedules from your last grade and ease factor. FSRS estimates stability and difficulty from review history, so due dates can change more aggressively.</small>
                </span>
                <select id="pref-srs-algorithm">
                  <option value="sm2" data-i18n="settings.srsAlgorithmSm2">SM-2 (classic)</option>
                  <option value="fsrs" data-i18n="settings.srsAlgorithmFsrs">FSRS (optional)</option>
                </select>
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.removalBehavior">Word removal behavior</span>
                  <small data-i18n="settings.removalBehaviorHint">Ignore keeps the entry and hides it from learning. Delete removes it completely, so the word appears as New again.</small>
                </span>
                <select id="pref-removal-behavior" data-pref="removalBehavior">
                  <option value="ignored" data-i18n="settings.removalBehaviorIgnored">Ignore (keep translation)</option>
                  <option value="delete" data-i18n="settings.removalBehaviorDelete">Delete (reset as 'new')</option>
                </select>
              </label>
            </div>
          </section>


          <!-- Phase 2 (#127 P3): Translator & Dictionary panel stays
               static in index.html until renderSettingsView() covers them. -->
          <section class="panel" aria-labelledby="translator-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.translatorEyebrow">Translator &amp; Dictionary</p>
              <h2 id="translator-prefs-heading" data-i18n="settings.translatorHeading">Translations and links</h2>
            </div>
            <div class="settings-body">
              <div id="pref-translation-language-settings" hidden>
                <label class="setting-row stack">
                  <span>
                    <span data-i18n="settings.translationSourceLanguage">Translation source language</span>
                    <small data-i18n="settings.translationLanguageHint">Enter a language code such as nl, pt-BR, or eo. The pair is shared by every translation engine in this profile.</small>
                  </span>
                  <input id="pref-translation-source-language" type="text" list="translation-language-codes" autocomplete="off" spellcheck="false" data-i18n-attr="placeholder=settings.translationSourceLanguagePlaceholder" class="input">
                </label>
                <label class="setting-row stack">
                  <span data-i18n="settings.translationTargetLanguage">Translation target language</span>
                  <input id="pref-translation-target-language" type="text" list="translation-language-codes" autocomplete="off" spellcheck="false" data-i18n-attr="placeholder=settings.translationTargetLanguagePlaceholder" class="input">
                </label>
                <datalist id="translation-language-codes">
                  <option value="de"></option>
                  <option value="en"></option>
                  <option value="es"></option>
                  <option value="fr"></option>
                  <option value="it"></option>
                  <option value="ja"></option>
                  <option value="pl"></option>
                  <option value="ru"></option>
                  <option value="uk"></option>
                  <option value="zh"></option>
                  <option value="la"></option>
                  <option value="grc"></option>
                </datalist>
              </div>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.offlineTranslator">Advanced offline translator</span>
                  <small data-i18n="settings.offlineTranslatorHint">Enables local CTranslate2 translation for words and full sentences. Works offline after downloading language packs (~100-200MB each).</small>
                </span>
                <input id="pref-offline-translator" type="checkbox">
              </label>
              <label class="setting-row">
                <span data-i18n="settings.translationProvider">Translation engine</span>
                <select id="pref-translation-provider">
                  <option value="offline" data-i18n="settings.translationProviderOffline">Offline CTranslate2</option>
                  <option value="deepl" data-i18n="settings.translationProviderDeepL">DeepL</option>
                  <option value="google" data-i18n="settings.translationProviderGoogle">Google Translate</option>
                  <option value="lmstudio" data-i18n="settings.translationProviderLmStudio">LM Studio</option>
                </select>
              </label>
              <label id="pref-deepl-key-row" class="setting-row stack" hidden>
                <span data-i18n="settings.deeplApiKey">DeepL API key</span>
                <input id="pref-deepl-api-key" type="password" data-i18n-attr="placeholder=settings.deeplApiKeyPlaceholder" class="input">
              </label>
              <label id="pref-lmstudio-endpoint-row" class="setting-row desktop-only-setting stack" hidden>
                <span data-i18n="settings.lmStudioEndpoint">LM Studio endpoint</span>
                <input id="pref-lmstudio-endpoint" type="text" class="input">
              </label>
              <label id="pref-lmstudio-model-row" class="setting-row desktop-only-setting stack" hidden>
                <span data-i18n="settings.lmStudioModel">LM Studio model</span>
                <input id="pref-lmstudio-model" type="text" data-i18n-attr="placeholder=settings.lmStudioModelPlaceholder" class="input">
              </label>
              <label id="pref-auto-translate-row" class="setting-row toggle-row dimmed">
                <span>
                  <span data-i18n="settings.autoTranslate">Auto-fill translation</span>
                  <small data-i18n="settings.autoTranslateHint">When a saved word has an empty translation, fills it with the selected translation engine. Manual translations stay untouched.</small>
                </span>
                <input id="pref-auto-translate" type="checkbox" data-pref="autoTranslateWords">
              </label>
              <label id="pref-argos-as-dict-row" class="setting-row toggle-row desktop-only-setting dimmed">
                <span>
                  <span data-i18n="settings.argosAsDict">Dictionary button opens translator</span>
                  <small data-i18n="settings.argosAsDictHint">Makes the dictionary button (M) open the built-in offline translator for the selected word instead of your dictionary URL.</small>
                </span>
                <input id="pref-argos-as-dict" type="checkbox" data-pref="argosAsDict">
              </label>
              <label class="setting-row desktop-only-setting">
                <span data-i18n="settings.dictionaryMode">Open Dictionary in</span>
                <select id="pref-dictionary-mode" data-pref="dictionaryMode">
                  <option value="internal" data-i18n="settings.dictModeInternal">Internal window</option>
                  <option value="external" data-i18n="settings.dictModeExternal">External browser</option>
                </select>
              </label>
              <label class="setting-row desktop-only-setting">
                <span data-i18n="settings.youglishMode">Opening YouGlish</span>
                <select id="pref-youglish-mode" data-pref="youglishMode">
                  <option value="internal" data-i18n="settings.dictModeInternal">Internal window</option>
                  <option value="external" data-i18n="settings.dictModeExternal">External browser</option>
                </select>
              </label>
              <label class="setting-row stack">
                <span data-i18n="settings.dictionaryUrl">Dictionary URL (use {{word}})</span>
                <input id="pref-dictionary-url" type="text" data-pref="dictionaryUrl" data-i18n-attr="placeholder=settings.dictionaryUrlPlaceholder" placeholder="https://en.wiktionary.org/wiki/{{word}}" class="input">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="ai-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.aiEyebrow">AI explanations</p>
              <h2 id="ai-prefs-heading" data-i18n="settings.aiHeading">AI explanations of words and phrases</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupAi">Language assistant</p>
              <p class="muted-copy" data-i18n="settings.aiHint">Explains the selected word or phrase based on the sentence it appears in. Works with any OpenAI-compatible server — local (LM Studio, llama.cpp, Ollama) or remote (e.g. opencode.ai, OpenAI, DeepSeek).</p>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.aiExplanations">Enable AI explanations</span>
                  <small data-i18n="settings.aiExplanationsHint">Adds an “Explain” button to the word panel. The API key is stored locally and sent only to the endpoint you choose.</small>
                </span>
                <input id="pref-ai-explanations" type="checkbox">
              </label>
              <label id="pref-ai-endpoint-row" class="setting-row stack" hidden>
                <span data-i18n="settings.aiEndpoint">Endpoint (OpenAI-compatible)</span>
                <input id="pref-ai-endpoint" type="text" class="input">
              </label>
              <div id="pref-ai-model-row" class="setting-row stack" hidden>
                <label for="pref-ai-model" data-i18n="settings.aiModel">Model</label>
                <div class="ai-model-picker">
                  <div class="ai-model-input-row">
                    <input id="pref-ai-model" type="text" autocomplete="off" data-i18n-attr="placeholder=settings.aiModelPlaceholder" class="input">
                    <button id="pref-ai-model-refresh" type="button" class="secondary-button" data-i18n="settings.aiModelsRefresh">Refresh models</button>
                  </div>
                  <input id="pref-ai-model-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="pref-ai-model-options" autocomplete="off" enterkeyhint="done" data-i18n-attr="placeholder=settings.aiModelsSearch,aria-label=settings.aiModelsSearch" class="input">
                  <small id="pref-ai-model-status" class="ai-model-status" role="status" aria-live="polite"></small>
                  <div id="pref-ai-model-options" class="ai-model-options" role="listbox" data-i18n-attr="aria-label=settings.aiModel" hidden></div>
                </div>
              </div>
              <label id="pref-ai-key-row" class="setting-row stack" hidden>
                <span data-i18n="settings.aiApiKey">API key</span>
                <input id="pref-ai-api-key" type="password" data-i18n-attr="placeholder=settings.aiApiKeyPlaceholder" class="input">
              </label>
              <label id="pref-ai-effort-row" class="setting-row stack" hidden>
                <span>
                  <span data-i18n="settings.aiEffort">Reasoning effort</span>
                  <small data-i18n="settings.aiEffortHint">How much effort the model should put into reasoning. Empty = do not send — the endpoint uses its own default.</small>
                </span>
                <select id="pref-ai-effort" class="input">
                  <option value="" data-i18n="settings.aiEffortAuto">Automatic (do not send)</option>
                  <option value="minimal" data-i18n="settings.aiEffortMinimal">Minimal</option>
                  <option value="low" data-i18n="settings.aiEffortLow">Low</option>
                  <option value="medium" data-i18n="settings.aiEffortMedium">Medium</option>
                  <option value="high" data-i18n="settings.aiEffortHigh">High</option>
                  <option value="max" data-i18n="settings.aiEffortMax">Maximum</option>
                </select>
              </label>
              <label id="pref-ai-auto-trigger-row" class="setting-row toggle-row" hidden>
                <span>
                  <span data-i18n="settings.aiAutoTrigger">Explain new words automatically</span>
                  <small data-i18n="settings.aiAutoTriggerHint">When a word without an AI explanation is opened, the explanation is fetched automatically and appended to the word's note.</small>
                </span>
                <input id="pref-ai-auto-trigger" type="checkbox">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="data-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.dataEyebrow">Local data</p>
              <h2 id="data-heading" data-i18n="settings.dataHeading">Import and export</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupLocalData">Data on this device</p>
              <p class="muted-copy" id="storage-summary"></p>
              <p class="muted-copy" id="data-directory"></p>
              <div class="data-actions compact-actions desktop-only-setting">
                <button id="choose-data-directory" type="button" class="secondary-button desktop-only-control" data-i18n="settings.chooseDataFolder">Choose local data folder</button>
              </div>
              <div id="recovery-status-panel" class="recovery-status-panel" hidden>
                <div id="recovery-status-list" class="recovery-status-list"></div>
              </div>
              <p class="settings-subheading" data-i18n="settings.groupBackup">Backup and import</p>
              <div class="data-actions">
                <section class="data-action-row desktop-only-setting">
                  <div class="data-action-copy">
                    <h3 data-i18n="update.checkTitle">App updates</h3>
                    <p data-i18n="update.checkHint">Manually check whether a newer version of Word Hunter is available.</p>
                  </div>
                  <div class="data-action-buttons">
                    <button class="secondary-button" type="button" id="check-updates" data-i18n="update.checkButton">Check for updates</button>
                  </div>
                </section>
                <section class="data-action-row">
                  <div class="data-action-copy">
                    <h3 data-i18n="settings.resetTitle">Restore settings</h3>
                    <p data-i18n="settings.resetHint">Resets theme, reader, dictionary, TTS, and other preferences to defaults. It does not delete words or texts.</p>
                  </div>
                  <div class="data-action-buttons">
                    <button class="secondary-button" type="button" id="reset-prefs" data-i18n="settings.resetPrefs">Reset Preferences</button>
                  </div>
                </section>

              </div>
            </div>
          </section>

        </div>
  `;
  // Mount inside .main-panel like the other views — appending to document.body
  // puts the view below the app shell (below the fold), making the Settings
  // tab look empty until the user scrolls.
  const host = document.querySelector<HTMLElement>("main.main-panel") ?? document.body;
  host.appendChild(view);
  return view;
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
  bindAiModelPicker();

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
      setElementBusy(byId<HTMLElement>("choose-data-directory"), false, { disable: true });
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


  if (byId<HTMLElement>("reset-prefs")) {
    byId<HTMLElement>("reset-prefs").addEventListener("click", async () => {
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

  localeSelects().forEach((control) => {
    control.addEventListener("change", async () => {
      const value = control.value;
      state.preferences.locale = value;
      saveState();
      await loadLocale(value);
      applyTranslations();
      // The word-editor status buttons are rendered text, not data-i18n;
      // rebuild them so an already-built dialog never keeps the old locale
      // (issue #274).
      refreshAddWordDialogLocalization();
      applyPlatformUi();
      applyPreferences();
      syncSettingsControls();
      render();
      showToast(t("toast.languageChanged", { name: t(`languages.${value}`) }));
    });
  });
  learningLanguageSelects().forEach((control) => {
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
  if (byId<HTMLSelectElement>("pref-srs-algorithm")) byId<HTMLSelectElement>("pref-srs-algorithm").addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLSelectElement;
    state.preferences.srsAlgorithm = target.value === "sm2" ? "sm2" : "fsrs";
    saveState();
    applyPreferences();
    renderReview();
  });
  if (byId<HTMLInputElement>("pref-in-text-review")) byId<HTMLInputElement>("pref-in-text-review").addEventListener("change", (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    updatePreferenceValue("inTextReview", target.checked);
    renderReader();
  });
  if (byId<HTMLSelectElement>("pref-review-graph-type")) byId<HTMLSelectElement>("pref-review-graph-type").addEventListener("change", (event: Event) => {
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
  if (byId<HTMLInputElement>("pref-ai-explanations")) {
    byId<HTMLInputElement>("pref-ai-explanations").addEventListener("change", (event: Event) => {
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
      if (target.checked) showCachedAiModels(false);
    });
  }
  if (byId<HTMLInputElement>("pref-ai-endpoint")) {
    byId<HTMLInputElement>("pref-ai-endpoint").addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationEndpoint", normalizeAiTextPreference("aiExplanationEndpoint", (event.currentTarget as HTMLInputElement).value));
      syncSettingsControls();
      cancelAiModelRefresh();
      showCachedAiModels(false);
    });
  }
  if (byId<HTMLInputElement>("pref-ai-model")) {
    byId<HTMLInputElement>("pref-ai-model").addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationModel", normalizeAiTextPreference("aiExplanationModel", (event.currentTarget as HTMLInputElement).value));
      syncSettingsControls();
    });
  }
  if (byId<HTMLInputElement>("pref-ai-api-key")) {
    byId<HTMLInputElement>("pref-ai-api-key").addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationApiKey", (event.currentTarget as HTMLInputElement).value.trim());
      cancelAiModelRefresh();
      showCachedAiModels(false);
    });
  }
  if (byId<HTMLSelectElement>("pref-ai-effort")) {
    byId<HTMLSelectElement>("pref-ai-effort").addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationEffort", normalizeAiTextPreference("aiExplanationEffort", (event.currentTarget as HTMLSelectElement).value));
      syncSettingsControls();
    });
  }
  if (byId<HTMLInputElement>("pref-ai-auto-trigger")) {
    byId<HTMLInputElement>("pref-ai-auto-trigger").addEventListener("change", (event: Event) => {
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

  byId<HTMLInputElement>("pref-card-stats").addEventListener("change", () => {
    updatePreferenceValue("showCardStats", byId<HTMLInputElement>("pref-card-stats").checked);
    syncSettingsControls();
    renderLibrary();
  });
  if (byId<HTMLInputElement>("pref-card-stats-mode")) {
    byId<HTMLInputElement>("pref-card-stats-mode").addEventListener("change", () => {
      updatePreferenceValue("cardStatsMode", byId<HTMLInputElement>("pref-card-stats-mode").value);
      renderLibrary();
    });
  }
  if (byId<HTMLInputElement>("pref-covers")) {
    byId<HTMLInputElement>("pref-covers").addEventListener("change", () => { updatePreferenceValue("showCovers", byId<HTMLInputElement>("pref-covers").checked); renderLibrary(); renderDiscover(); });
  }
  
  if (byId<HTMLInputElement>("pref-color-new")) byId<HTMLInputElement>("pref-color-new").addEventListener("input", (event: Event) => updatePreferenceValue("colorNew", (event.currentTarget as HTMLInputElement).value));
  if (byId<HTMLInputElement>("pref-color-learning")) byId<HTMLInputElement>("pref-color-learning").addEventListener("input", (event: Event) => updatePreferenceValue("colorLearning", (event.currentTarget as HTMLInputElement).value));
  if (byId<HTMLInputElement>("pref-color-known")) byId<HTMLInputElement>("pref-color-known").addEventListener("input", (event: Event) => updatePreferenceValue("colorKnown", (event.currentTarget as HTMLInputElement).value));
  if (byId<HTMLInputElement>("pref-color-ignored")) byId<HTMLInputElement>("pref-color-ignored").addEventListener("input", (event: Event) => updatePreferenceValue("colorIgnored", (event.currentTarget as HTMLInputElement).value));
  if (byId<HTMLInputElement>("pref-dynamic-learning-colors")) byId<HTMLInputElement>("pref-dynamic-learning-colors").addEventListener("change", (event: Event) => {
    updatePreferenceValue("dynamicLearningColors", (event.currentTarget as HTMLInputElement).checked);
    syncSettingsControls();
    renderReader();
  });
  if (learningColorInputs().length) {
    learningColorInputs().forEach((input) => input.addEventListener("input", () => {
      updatePreferenceValue("learningColors", learningColorInputs().map((color) => color.value));
      renderReader();
    }));
  }
  
  byId<HTMLInputElement>("pref-font-size")?.addEventListener("input", (event: Event) => setReaderFontSize((event.currentTarget as HTMLInputElement).value));

  if (byId<HTMLInputElement>("pref-ui-scale")) {
    byId<HTMLInputElement>("pref-ui-scale").addEventListener("input", (event: Event) => {
      setUiScale((event.currentTarget as HTMLInputElement).value);
    });
  }

  if (els.readerFontSizeSlider) {
    els.readerFontSizeSlider.addEventListener("input", () => setReaderFontSize(els.readerFontSizeSlider.value));
  }
}
