import { state } from "../../state.js";
import { els } from "../../dom.js";
import { setView } from "../../render.js";
import { setUiScale, getUiScale } from "../../preferences.js";
import { showToast } from "../../toast.js";
import { t } from "../../i18n.js";
import { closeYouGlish } from "../../youglish.js";
import { openDictionary } from "../shared.js";

export async function openReaderView() {
  const { openLastReadBook } = await import("../../book-actions.js");
  await openLastReadBook();
}

export function handleGlobalKeys(event, key, inField) {
  if (key === "escape") {
    if (inField) {
      event.target.blur();
      return true;
    }
    const activeImageSearch = document.querySelector('[id^="image-search-results-"]:not(:empty), [id^="review-image-search-results-"]:not(:empty)');
    if (activeImageSearch) {
      activeImageSearch.innerHTML = "";
      return true;
    }
    const modal = document.getElementById("youglish-modal");
    if (modal?.open) {
      event.preventDefault();
      closeYouGlish();
      return true;
    }
  }

  if (inField) return false;

  if (event.ctrlKey && event.altKey && (key === "=" || key === "+" || key === "-" || key === "0")) {
    event.preventDefault();
    const value = setUiScale(key === "0" ? 100 : getUiScale() + (key === "-" ? -5 : 5));
    showToast(t("toast.uiScale", { n: value }));
    return true;
  }

  if (event.ctrlKey && /^[1-4]$/.test(key)) {
    const suggestion = document.querySelectorAll(".search-img-suggestion")[Number(key) - 1];
    if (suggestion) {
      event.preventDefault();
      suggestion.click();
      return true;
    }
  }

  if (key === "pageup" || key === "pagedown") {
    const button = document.getElementById(key === "pageup" ? "btn-prev-page" : "btn-next-page");
    if (button && !button.disabled) {
      event.preventDefault();
      button.click();
    }
    return true;
  }

  if (key === "b" && event.ctrlKey) {
    event.preventDefault();
    document.getElementById("text-select")?.focus();
    return true;
  }
  if (event.ctrlKey && (key === "=" || key === "+" || key === "-")) {
    event.preventDefault();
    document.querySelector(`button[data-font="${key === "-" ? "down" : "up"}"]`)?.click();
    return true;
  }

  if (key === "g" && event.ctrlKey && state.currentView === "reader") {
    event.preventDefault();
    const input = document.getElementById("page-jump-input");
    input?.focus();
    input?.select();
    return true;
  }
  if (key === "t" && event.ctrlKey && event.shiftKey) {
    event.preventDefault();
    els.themeToggle?.click();
    return true;
  }

  const views = { "?": "help", b: "library", d: "discover", f: "flashcards", g: "graphs", s: "settings", t: "translator", v: "vocabulary" };
  if (key === "r") {
    event.preventDefault();
    openReaderView();
    return true;
  }
  if (views[key]) {
    event.preventDefault();
    setView(views[key]);
    return true;
  }

  if (key === "/" && !event.ctrlKey) {
    const selector = { library: "#library-search", discover: "#discover-query", vocabulary: "#vocab-search" }[state.currentView];
    const input = selector && document.querySelector(selector);
    if (input) {
      event.preventDefault();
      input.focus();
      input.select();
      return true;
    }
  }

  if (key === "m" && state.currentView !== "reader" && state.preferences?.argosAsDict && state.preferences?.offlineTranslator) {
    event.preventDefault();
    openDictionary("");
    return true;
  }
  return false;
}
