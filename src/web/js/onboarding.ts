/**
 * Language-onboarding dialog (Android first run). Built once at app boot
 * before cacheElements() (app.ts), so els-free consumers and the boot-time
 * applyTranslations() pass find the elements in the DOM. The two selects
 * bind their own change handlers here — they are intentionally left out of
 * the shared prefLocales / prefLearningLanguages els arrays (dom.ts), whose
 * loops drive the Settings dialog controls only (events/settings.ts,
 * preferences.ts). The dialog open/close flow stays in app.ts
 * (showLanguageOnboardingIfNeeded).
 */
import { state, saveState, switchLearningLanguage } from "./state.js";
import { t, loadLocale, applyTranslations } from "./i18n.js";
import { render } from "./render.js";
import { applyPreferences, syncSettingsControls } from "./preferences.js";
import { applyPlatformUi } from "./platform.js";
import { showToast } from "./toast.js";

/**
 * Builds the language-onboarding dialog markup once (idempotent). Options
 * are kept as literal markup (like the ported static block) so audits can
 * diff them against the shipped locale lists.
 */
export function renderLanguageOnboardingDialog(): HTMLDialogElement {
  const existing = document.getElementById("language-onboarding-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#language-onboarding-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "language-onboarding-dialog";
  dialog.className = "panel language-onboarding-dialog";
  dialog.setAttribute("aria-labelledby", "language-onboarding-title");
  dialog.innerHTML = `
    <div class="language-onboarding-body">
      <p class="eyebrow" data-i18n="onboarding.languageEyebrow">Word Hunter Pocket</p>
      <h2 id="language-onboarding-title" data-i18n="onboarding.languageHeading">Choose your languages</h2>
      <p class="muted-copy" data-i18n="onboarding.languageCopy">Pick the app language and the language profile you want to learn first. You can change both later in Settings.</p>
      <label class="language-setting-row language-onboarding-row">
        <span class="language-setting-title" data-i18n="settings.interfaceLanguageTitle">App interface language</span>
        <span class="language-select-wrap">
          <img class="language-select-flag" data-language-flag="locale" src="flags/en.svg" alt="" aria-hidden="true">
          <select id="pref-locale-onboarding" aria-label="App interface language" data-i18n-attr="aria-label=settings.interfaceLanguageTitle">
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
      <label class="language-setting-row language-onboarding-row">
        <span class="language-setting-title" data-i18n="settings.learningLanguageTitle">Learning language (profile)</span>
        <span class="language-select-wrap">
          <img class="language-select-flag" data-language-flag="learning" src="flags/de.svg" alt="" aria-hidden="true">
          <select id="pref-learning-language-onboarding" aria-label="Learning language (profile)" data-i18n-attr="aria-label=settings.learningLanguageTitle">
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
      <button id="language-onboarding-done" class="primary-button" type="button" data-i18n="onboarding.continue">Continue</button>
    </div>
  `;
  document.body.appendChild(dialog);

  // Keep the controls in sync with the current preferences (the shared
  // syncSettingsControls() pass skips these selects) and apply the same
  // change behavior the Settings dialog controls have.
  const localeSelect = dialog.querySelector<HTMLSelectElement>("#pref-locale-onboarding");
  const learningSelect = dialog.querySelector<HTMLSelectElement>("#pref-learning-language-onboarding");
  if (localeSelect) {
    localeSelect.value = state.preferences?.locale || "pl";
    localeSelect.addEventListener("change", async () => {
      const value = localeSelect.value;
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
  }
  if (learningSelect) {
    learningSelect.value = state.preferences?.learningLanguage || "en";
    learningSelect.addEventListener("change", () => {
      switchLearningLanguage(learningSelect.value);
      applyPreferences();
      syncSettingsControls();
      render();
      showToast(t("toast.learningLanguageChanged"));
    });
  }
  return dialog;
}
