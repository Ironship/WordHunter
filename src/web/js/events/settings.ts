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
              <label id="pref-ai-model-row" class="setting-row stack" hidden>
                <span data-i18n="settings.aiModel">Model</span>
                <input id="pref-ai-model" type="text" data-i18n-attr="placeholder=settings.aiModelPlaceholder" class="input">
              </label>
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
  // Phase 2 (#127 P3): the Reader and Translator panels stay static in
  // index.html (no shell) and are moved into the settings grid at boot so
  // the shell + phase-1 markup lives only in this renderer.
  const grid = view.querySelector(".settings-grid");
  if (grid) {
    const readerPanel = document.getElementById("reader-prefs-panel");
    if (readerPanel) grid.appendChild(readerPanel);
    const translatorPanel = document.getElementById("translator-prefs-panel");
    if (translatorPanel) grid.appendChild(translatorPanel);
  }
  document.body.appendChild(view);
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
    });
  }
  if (byId<HTMLInputElement>("pref-ai-endpoint")) {
    byId<HTMLInputElement>("pref-ai-endpoint").addEventListener("change", (event: Event) => {
      updatePreferenceValue("aiExplanationEndpoint", normalizeAiTextPreference("aiExplanationEndpoint", (event.currentTarget as HTMLInputElement).value));
      syncSettingsControls();
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
  
  els.prefFontSize.addEventListener("input", (event: Event) => setReaderFontSize((event.currentTarget as HTMLInputElement).value));

  if (byId<HTMLInputElement>("pref-ui-scale")) {
    byId<HTMLInputElement>("pref-ui-scale").addEventListener("input", (event: Event) => {
      setUiScale((event.currentTarget as HTMLInputElement).value);
    });
  }

  if (els.readerFontSizeSlider) {
    els.readerFontSizeSlider.addEventListener("input", () => setReaderFontSize(els.readerFontSizeSlider.value));
  }
}
