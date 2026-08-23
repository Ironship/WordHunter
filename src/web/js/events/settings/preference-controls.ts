// Generic [data-pref] control binding plus the selected-word-panel item
// settings, split out of the former monolithic events/settings.ts.
import { state, saveState } from "../../state.js";
import { els } from "../../dom.js";
import { syncSettingsControls, updatePreferenceValue } from "../../preferences.js";
import { normalizeSelectedWordPanelItems } from "../../state/normalize.js";
import { getTextById } from "../../reader/renderer.js";
import { renderWordPanel } from "../../reader/word-panel.js";

export function bindPreferenceControls() {
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
          const { playStatusSound } = await import("../../status-sounds.js");
          playStatusSound(key === "statusSoundsEnabled" ? "new" : "known");
        }
      }
    });
  });
}

export function saveSelectedWordPanelItems(items: WhSelectedWordPanelItem[]): void {
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

export function bindSelectedWordPanelSettings(): void {
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
