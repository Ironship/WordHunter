// Appearance settings section (former monolithic events/settings.ts): card
// stats & cover toggles, status color pickers, dynamic learning colors and
// the reader font-size / UI-scale sliders.
import { els } from "../../dom.js";
import { updatePreferenceValue, syncSettingsControls, setReaderFontSize, setUiScale } from "../../preferences.js";
import { renderLibrary } from "../../views/library.js";
import { renderReader } from "../../reader/renderer.js";
import { renderDiscover } from "../../views/discover.js";
import { byId } from "./shared.js";

function learningColorInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("[data-learning-color]"));
}

export function bindAppearanceSettings() {
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
