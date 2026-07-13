import { state } from "../../state.js";
import { els } from "../../dom.js";
import { getNavigationEpoch, setView } from "../../render.js";
import { setUiScale, getUiScale } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { t } from "../../i18n.js";
import { closeYouGlish } from "../../youglish.js";
import { openDictionary } from "../shared.js";

export async function openReaderView(): Promise<boolean> {
  const startingNavigationEpoch = getNavigationEpoch();
  const { openLastReadBook } = await import("../../book-actions.js");
  if (startingNavigationEpoch !== getNavigationEpoch()) return false;
  await openLastReadBook();
  return true;
}

function noCommandModifiers(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.metaKey;
}

function plainKey(event: KeyboardEvent): boolean {
  return noCommandModifiers(event) && !event.shiftKey;
}

function navigationKey(event: KeyboardEvent, key: string): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && (key === "?" || !event.shiftKey);
}

function activeImageSearchContainer(): HTMLElement | null {
  const prefix = state.currentView === "flashcards"
    ? "review-image-search-results-"
    : "image-search-results-";
  return document.querySelector<HTMLElement>(`[id^="${prefix}"]:not(:empty)`);
}

export function handleGlobalKeys(event: KeyboardEvent, key: string, inField: boolean): boolean {
  if (key === "escape") {
    if (inField) {
      if (event.target instanceof HTMLElement) event.target.blur();
      return true;
    }
    const activeImageSearch = document.querySelector('[id^="image-search-results-"]:not(:empty), [id^="review-image-search-results-"]:not(:empty)');
    if (activeImageSearch) {
      activeImageSearch.innerHTML = "";
      return true;
    }
    const modal = document.getElementById("youglish-modal");
    if (modal instanceof HTMLDialogElement && modal.open) {
      event.preventDefault();
      closeYouGlish();
      return true;
    }
  }

  if (inField) return false;

  if (event.ctrlKey && event.altKey && !event.metaKey && (key === "=" || key === "+" || key === "-" || key === "0")) {
    event.preventDefault();
    const value = setUiScale(key === "0" ? 100 : getUiScale() + (key === "-" ? -5 : 5));
    showToast(t("toast.uiScale", { n: value }));
    return true;
  }

  const imageDigit = /^[1-4]$/.test(key)
    ? key
    : event.code?.match(/^(?:Digit|Numpad)([1-4])$/)?.[1];
  if (event.ctrlKey && !event.altKey && !event.metaKey && imageDigit) {
    const container = activeImageSearchContainer();
    const suggestion = imageDigit === "4"
      ? container?.querySelector<HTMLButtonElement>('[data-action="upload-image"]')
      : container?.querySelectorAll<HTMLButtonElement>('[data-action="save-image"]')[Number(imageDigit) - 1];
    if (suggestion) {
      event.preventDefault();
      suggestion.click();
      return true;
    }
  }

  if (state.currentView === "reader" && plainKey(event) && (key === "pageup" || key === "pagedown")) {
    const button = document.getElementById(key === "pageup" ? "btn-prev-page" : "btn-next-page");
    if (button instanceof HTMLButtonElement && !button.disabled) {
      event.preventDefault();
      button.click();
    }
    return true;
  }

  if (state.currentView === "reader" && key === "b" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("text-select")?.focus();
    return true;
  }
  if (state.currentView === "reader" && event.ctrlKey && !event.altKey && !event.metaKey && (key === "=" || key === "+" || key === "-")) {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>(`button[data-font="${key === "-" ? "down" : "up"}"]`)?.click();
    return true;
  }

  if (key === "g" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && state.currentView === "reader") {
    event.preventDefault();
    const input = document.getElementById("page-jump-input");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
    return true;
  }
  if (key === "t" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    els.themeToggle?.click();
    return true;
  }

  const views: Partial<Record<string, string>> = { "?": "help", b: "library", d: "discover", f: "flashcards", g: "graphs", s: "settings", t: "translator", v: "vocabulary", y: "sync" };
  if (key === "r" && navigationKey(event, key)) {
    event.preventDefault();
    openReaderView();
    return true;
  }
  if (views[key] && navigationKey(event, key)) {
    const navItem = document.querySelector<HTMLButtonElement>(`[data-view="${views[key]}"]`);
    if (navItem?.disabled || navItem?.classList.contains("nav-item-locked")) return false;
    event.preventDefault();
    setView(views[key]);
    return true;
  }

  if (key === "/" && plainKey(event)) {
    const selector = { library: "#library-search", discover: "#discover-query", vocabulary: "#vocab-search" }[state.currentView];
    const input = selector && document.querySelector<HTMLInputElement>(selector);
    if (input) {
      event.preventDefault();
      input.focus();
      input.select();
      return true;
    }
  }

  if (key === "m" && plainKey(event) && state.currentView !== "reader" && state.preferences?.argosAsDict && state.preferences?.offlineTranslator) {
    event.preventDefault();
    openDictionary("");
    return true;
  }
  return false;
}
