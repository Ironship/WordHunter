// Punkt wejścia aplikacji. Składa moduły, nie zawiera logiki domenowej.
import { cacheElements, els } from "./js/dom.js";
import { showToast } from "./js/toast.js";
import { bindEvents } from "./js/events.js";
import { applyPreferences, syncSettingsControls } from "./js/preferences.js";
import { hydrateCurrentReaderText, loadBooksCatalog } from "./js/books.js";
import { render, ensureCurrentText } from "./js/render.js";
import { loadLocale, applyTranslations, t } from "./js/i18n.js";
import { applyBridgeSnapshotToState, flushFrontendStateBuffers, flushUiStateSync, saveState, state } from "./js/state.js";
import { bindLibraryEvents, renderLibrary } from "./js/views/library.js";
import { renderReview, renderVocabulary } from "./js/views/vocabulary.js";
import { applyPlatformUi, detectPlatform, isAndroidPlatform, openAndroidUrl } from "./js/platform.js";
import { refreshYouGlishTheme } from "./js/youglish.js";
import { fetchWithTimeout } from "./js/request.js";

detectPlatform();

function reportClientError(text: string, error?: unknown): void {
  document.documentElement.classList.remove("app-booting");
  console.error(text, error || "");
  try {
    fetch("/__log_error", { method: "POST", body: text });
  } catch {}
}

function showStartupFailure(error: unknown): void {
  const panel = document.querySelector<HTMLElement>(".main-panel");
  if (!panel) return;
  panel.replaceChildren();
  const message = document.createElement("section");
  message.className = "empty-row";
  const title = document.createElement("h1");
  title.textContent = "Word Hunter could not finish startup";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement("button");
  retry.className = "primary-button";
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  message.append(title, detail, retry);
  panel.append(message);
}

window.onerror = function(msg, url, line, col, error) {
  reportClientError(t("app.jsError", { msg, url, line, col, stack: error?.stack || "" }), error);
};

if (window.wordHunterBootRejectionHandler) {
  window.removeEventListener("unhandledrejection", window.wordHunterBootRejectionHandler);
  delete window.wordHunterBootRejectionHandler;
}
window.addEventListener("unhandledrejection", function(event) {
  reportClientError(t("app.unhandledPromise", { reason: event.reason }), event.reason);
});

let lifecycleFlushStarted = false;
function flushPendingStateBeforeExit() {
  if (lifecycleFlushStarted) return;
  lifecycleFlushStarted = true;
  flushFrontendStateBuffers();
  flushUiStateSync();
  if (isAndroidPlatform()) {
    saveState();
    return;
  }
  if (typeof window.flushPendingSave === "function") window.flushPendingSave();
}

window.addEventListener("beforeunload", flushPendingStateBeforeExit);
window.addEventListener("pagehide", flushPendingStateBeforeExit);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingStateBeforeExit();
  else lifecycleFlushStarted = false;
});
window.addEventListener("pageshow", () => { lifecycleFlushStarted = false; });

document.addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target
    : event.target instanceof Node
      ? event.target.parentElement
      : null;
  const link = target?.closest('a[href^="http"]');
  if (!(link instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  if (openAndroidUrl(link.href)) return;
  if (window.__qtBridge) {
    fetch("/__open_dict?url=" + encodeURIComponent(link.href) + "&mode=external")
      .catch((error) => console.warn("Failed to open external link", error));
  } else {
    window.open(link.href, "_blank", "noopener,noreferrer");
  }
});

window.addEventListener("vocab-index:loaded", () => {
  if (state.currentView === "library") renderLibrary();
  if (state.currentView === "vocabulary") { renderVocabulary(); renderReview(); }
});

let libraryStatsRenderTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("text-stats:loaded", () => {
  if (state.currentView !== "library") return;
  clearTimeout(libraryStatsRenderTimer);
  libraryStatsRenderTimer = setTimeout(() => {
    libraryStatsRenderTimer = null;
    if (state.currentView === "library") renderLibrary();
  }, 50);
});

let graphResizeTimer: number | null = null;
window.addEventListener("resize", () => {
  if (state.currentView !== "graphs") return;
  clearTimeout(graphResizeTimer);
  graphResizeTimer = setTimeout(render, 120);
});

window.addEventListener("wordhunter:state-save-error", () => {
  showToast(t("toast.saveUnavailable"));
});

window.addEventListener("wordhunter:state-replaced", () => {
  applyPreferences();
  syncSettingsControls();
});

window.addEventListener("wordhunter:theme-changed", () => {
  if (document.documentElement.classList.contains("app-booting")) return;
  refreshYouGlishTheme();
  if (state.currentView === "graphs") import("./js/views/graphs.js").then((module) => module.renderGraphs());
  if (["vocabulary", "flashcards"].includes(state.currentView)) renderReview();
});

async function loadBridgeStateBeforeRender() {
  if (!window.__qtBridge || window.__bridgeState) return;
  if (window.__bridgeStatePromise) {
    applyBridgeSnapshotToState(await window.__bridgeStatePromise);
    delete window.__bridgeStatePromise;
    return;
  }
  const response = await fetchWithTimeout("/__store/load", { cache: "no-store" }, 12_000);
  if (!response.ok) throw new Error(`Store load failed: HTTP ${response.status}`);
  applyBridgeSnapshotToState(await response.json());
}

function showLanguageOnboardingIfNeeded() {
  if (!isAndroidPlatform() || state.preferences.languageOnboardingDone === true) return;
  const dialog = els.languageOnboardingDialog;
  const doneButton = els.languageOnboardingDone;
  if (!(dialog instanceof HTMLDialogElement) || !(doneButton instanceof HTMLButtonElement)) return;
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  doneButton.addEventListener("click", () => {
    state.preferences.languageOnboardingDone = true;
    saveState();
    dialog.close();
  }, { once: true });
  dialog.showModal();
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    cacheElements();
    await loadBridgeStateBeforeRender();
    await Promise.all([
      applyPreferences(),
      loadLocale(state.preferences?.locale || "en"),
      loadBooksCatalog()
    ]);
    applyTranslations();
    ensureCurrentText();
    bindEvents();
    bindLibraryEvents();
    import("./js/views/reader.js").then(m => m.bindReaderEvents());
    syncSettingsControls();
    applyPlatformUi();
    render();
    const restoringReaderTextId = state.currentView === "reader" ? state.currentTextId : null;
    void hydrateCurrentReaderText()
      .then((ready) => {
        if (ready && restoringReaderTextId && state.currentView === "reader" && state.currentTextId === restoringReaderTextId) render();
      })
      .catch((error) => console.warn("Could not restore the active Reader body after startup:", error));
    document.getElementById("app-font-stylesheet")?.setAttribute("rel", "stylesheet");
    showLanguageOnboardingIfNeeded();
  } catch (error) {
    reportClientError(`Startup failed: ${error?.stack || error}`, error);
    showStartupFailure(error);
  } finally {
    if (window.wordHunterBootTimeout !== undefined) {
      clearTimeout(window.wordHunterBootTimeout);
      delete window.wordHunterBootTimeout;
    }
    document.documentElement.classList.remove("app-booting");
  }
  window.requestAnimationFrame(() => {
    if (document.documentElement.dataset.platform === "android") return;
    setTimeout(() => import("./js/update-checker.js").then(m => m.checkForUpdates()), 0);
  });
});
