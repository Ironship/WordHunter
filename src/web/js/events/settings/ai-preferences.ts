// AI explanation preference listeners (former monolithic
// events/settings.ts): enable toggle, endpoint/model/api-key/effort and
// auto-trigger controls. The model picker itself lives in ai-models.ts.
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import { syncSettingsControls, updatePreferenceValue } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { normalizeAiTextPreference } from "../../ai-explainer.js";
import { normalizeSelectedWordPanelItems } from "../../state/normalize.js";
import { byId } from "./shared.js";

type AiPreferencesDeps = {
  saveSelectedWordPanelItems(items: WhSelectedWordPanelItem[]): void;
  showCachedAiModels(open?: boolean): void;
  cancelAiModelRefresh(): void;
};

export function bindAiPreferenceSettings(deps: AiPreferencesDeps) {
  const { saveSelectedWordPanelItems, showCachedAiModels, cancelAiModelRefresh } = deps;
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
}
