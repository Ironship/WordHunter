// Orchestrator barrel for the split settings-events module: composes the
// section binders in the original binding order of bindSettingsEvents() and
// re-exports the public API so existing consumers ("./events/settings.js")
// stay untouched.
import { bindAiModelPicker } from "./ai-models.js";
import { saveSelectedWordPanelItems, bindSelectedWordPanelSettings, bindPreferenceControls } from "./preference-controls.js";
import { showCachedAiModels, cancelAiModelRefresh } from "./ai-models.js";
import { bindAiPreferenceSettings } from "./ai-preferences.js";
import { applyBridgeSnapshot, bindDataSettings } from "./data.js";
import { bindLanguageSettings } from "./languages.js";
import { bindReviewSettings } from "./review.js";
import {
  registerArgosUnsavedDialog,
  bindTranslationProviderSettings,
  bindOfflineTranslatorSettings
} from "./translator.js";
import { bindAppearanceSettings } from "./appearance.js";
import { renderArgosDownloadDialog, renderSettingsView } from "./renderers.js";

export { applyBridgeSnapshot };
export { renderArgosDownloadDialog };
export { renderSettingsView };

export function bindSettingsEvents() {
  bindAiModelPicker();

  registerArgosUnsavedDialog();
  // Settings
  bindPreferenceControls();
  bindSelectedWordPanelSettings();
  bindDataSettings();
  bindLanguageSettings();
  bindReviewSettings();
  bindTranslationProviderSettings();
  bindAiPreferenceSettings({ saveSelectedWordPanelItems, showCachedAiModels, cancelAiModelRefresh });
  bindOfflineTranslatorSettings();
  bindAppearanceSettings();
}
