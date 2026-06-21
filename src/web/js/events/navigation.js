import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { setView } from "../render.js";
import { updatePreferenceValue, applyPreferences, themeLabel } from "../preferences.js";
import { renderLibrary } from "../views/library.js";
import { renderReader } from "../views/reader.js";
import { renderReview } from "../views/vocabulary.js";
import { showToast } from "../toast.js";
import { t } from "../i18n.js";
import { handleGlobalKeys, openReaderView } from "./keyboard/global-keys.js";
import { handleReaderKeys } from "./keyboard/reader-keys.js";
import { handleFlashcardKeys } from "./keyboard/flashcards-keys.js";

export function bindNavigationEvents() {
  els.navItems.forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.view === "reader") openReaderView(); else setView(button.dataset.view);
  }));

  els.themeToggle.addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    const next = order[(order.indexOf(state.preferences.theme || "auto") + 1) % order.length];
    updatePreferenceValue("theme", next);
    renderLibrary();
    renderReader();
    showToast(t("toast.themeChanged", { name: themeLabel(next) }));
  });

  document.addEventListener("keydown", handleGlobalKeydown);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((state.preferences?.theme || "auto") === "auto") applyPreferences();
  });
  els.reviewReverseToggle?.addEventListener("click", () => {
    state.preferences.reviewReverse = !state.preferences.reviewReverse;
    saveState();
    renderReview();
  });
}

function handleGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  if (!event.key) return;
  const key = event.key.toLowerCase();
  const inField = event.target?.matches?.("input, textarea, select, [contenteditable=true]");

  if ((inField || key === "escape") && handleGlobalKeys(event, key, inField)) return;
  if (inField) return;
  if (state.currentView === "flashcards" && handleFlashcardKeys(event, key)) return;
  if (state.currentView === "reader" && handleReaderKeys(event, key)) return;
  handleGlobalKeys(event, key, false);
}
