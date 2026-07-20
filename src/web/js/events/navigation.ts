import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { setView } from "../render.js";
import { updatePreferenceValue, applyPreferences, themeLabel } from "../preferences.js";
import { renderReview } from "../views/vocabulary.js";
import { showToast } from "../toast.js";
import { t } from "../i18n.js";
import { handleGlobalKeys, openReaderView } from "./keyboard/global-keys.js";
import { handleReaderKeys } from "./keyboard/reader-keys.js";
import { handleFlashcardKeys } from "./keyboard/flashcards-keys.js";
import { nextTheme, normalizeTheme } from "../theme.js";

export function bindNavigationEvents() {
  els.navItems.forEach((button) => button.addEventListener("click", () => {
    if (button.classList.contains("nav-item-locked") || button.getAttribute("aria-disabled") === "true") return;
    if (button.dataset.view === "reader") openReaderView(); else setView(button.dataset.view);
  }));
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-open-view]")
      : null;
    if (!button) return;
    if (button.dataset.openView === "reader") openReaderView(); else setView(button.dataset.openView);
  });
  document.getElementById("app-reload")?.addEventListener("click", () => window.location.reload());

  els.themeToggle.addEventListener("click", () => {
    const next = nextTheme(state.preferences.theme);
    updatePreferenceValue("theme", next);
    showToast(t("toast.themeChanged", { name: themeLabel(next) }));
  });

  document.addEventListener("keydown", handleGlobalKeydown);
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const handleColorSchemeChange = () => {
    if (["familiar", "alternative-familiar", "classic-auto"].includes(normalizeTheme(state.preferences?.theme))) {
      applyPreferences();
    }
  };
  if (typeof colorScheme?.addEventListener === "function") colorScheme.addEventListener("change", handleColorSchemeChange);
  else colorScheme?.addListener?.(handleColorSchemeChange);
  els.reviewReverseToggle?.addEventListener("click", () => {
    state.preferences.reviewReverse = !state.preferences.reviewReverse;
    saveState();
    renderReview();
  });
}

export function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (!event.key) return;
  if (event.isComposing) return;
  const key = event.key.toLowerCase();
  const fieldSelector = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
  const activeElement = document.activeElement;
  const inField = !!(
    (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest(fieldSelector)))
    || (activeElement instanceof HTMLElement && (activeElement.isContentEditable || activeElement.closest(fieldSelector)))
  );

  if ((inField || key === "escape") && handleGlobalKeys(event, key, inField)) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.repeat && !["arrowleft", "arrowright", "arrowup", "arrowdown", "pageup", "pagedown"].includes(key)) return;
  if (state.currentView === "reader"
    && ((key === "enter" && event.ctrlKey) || key === "f6")
    && handleReaderKeys(event, key)) return;
  if (inField) return;
  const imageShortcut = event.ctrlKey && (/^[1-4]$/.test(key) || /^(?:Digit|Numpad)[1-4]$/.test(event.code || ""));
  if (imageShortcut && handleGlobalKeys(event, key, false)) return;
  if (state.currentView === "flashcards" && handleFlashcardKeys(event, key)) return;
  if (state.currentView === "reader" && handleReaderKeys(event, key)) return;
  handleGlobalKeys(event, key, false);
}
