// Language settings section (former monolithic events/settings.ts): app
// locale selectors and learning-language selectors mirrored across the
// sidebar, settings panel and onboarding dialogs.
import { state, saveState, switchLearningLanguage } from "../../state.js";
import { t, loadLocale, applyTranslations } from "../../i18n.js";
import { render } from "../../render.js";
import { refreshAddWordDialogLocalization } from "../word-editor.js";
import { applyPreferences, syncSettingsControls } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { applyPlatformUi } from "../../platform.js";
import { byId } from "./shared.js";

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

export function bindLanguageSettings() {
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
}
