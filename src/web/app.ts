// Punkt wejścia aplikacji. Składa moduły, nie zawiera logiki domenowej.
import { cacheElements, els } from "./js/dom.js";
import { showToast } from "./js/toast.js";
import { bindEvents } from "./js/events.js";
import { applyPreferences, setSyncStatus, syncSettingsControls } from "./js/preferences.js";
import { hydrateActiveLibraryTexts, loadBooksCatalog } from "./js/books.js";
import { render, ensureCurrentText } from "./js/render.js";
import { loadLocale, applyTranslations, t } from "./js/i18n.js";
import { applyBridgeSnapshotToState, flushFrontendStateBuffers, saveState, state } from "./js/state.js";
import { bindLibraryEvents, renderLibrary } from "./js/views/library.js";
import { renderReview, renderVocabulary } from "./js/views/vocabulary.js";
import { applyPlatformUi, detectPlatform, isAndroidPlatform, openAndroidUrl } from "./js/platform.js";

detectPlatform();

function reportClientError(text: string, error?: unknown): void {
  document.documentElement.classList.remove("app-booting");
  console.error(text, error || "");
  try {
    fetch("/__log_error", { method: "POST", body: text });
  } catch {}
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

function flushPendingStateBeforeExit() {
  flushFrontendStateBuffers();
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
});

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

let libraryStatsRenderPending = false;
window.addEventListener("text-stats:loaded", () => {
  if (state.currentView !== "library" || libraryStatsRenderPending) return;
  libraryStatsRenderPending = true;
  const renderStats = () => {
    libraryStatsRenderPending = false;
    if (state.currentView === "library") renderLibrary();
  };
  if (window.requestAnimationFrame) window.requestAnimationFrame(renderStats);
  else setTimeout(renderStats, 0);
});

let graphResizeTimer: number | null = null;
window.addEventListener("resize", () => {
  if (state.currentView !== "graphs") return;
  clearTimeout(graphResizeTimer);
  graphResizeTimer = setTimeout(render, 120);
});

window.addEventListener("wordhunter:sync-conflict", () => {
  setSyncStatus("Error");
  showToast(t("toast.syncConflict"));
});

window.addEventListener("wordhunter:sync-error", () => {
  setSyncStatus("Error");
  showToast(t("toast.syncUnavailable"));
});

window.addEventListener("wordhunter:sync-saved", (event) => {
  const time = event instanceof CustomEvent && typeof event.detail?.time === "string"
    ? event.detail.time
    : new Date().toLocaleTimeString();
  setSyncStatus("Saved", { time });
});

window.addEventListener("wordhunter:state-replaced", () => {
  applyPreferences();
  syncSettingsControls();
});

window.addEventListener("wordhunter:theme-changed", () => {
  if (document.documentElement.classList.contains("app-booting")) return;
  if (state.currentView === "graphs") import("./js/views/graphs.js").then((module) => module.renderGraphs());
  if (["vocabulary", "flashcards"].includes(state.currentView)) renderReview();
});

async function loadBridgeStateBeforeRender() {
  if (!window.__qtBridge || window.__bridgeState) return;
  const response = await fetch("/__store/load", { cache: "no-store" });
  if (!response.ok) throw new Error(`Store load failed: HTTP ${response.status}`);
  applyBridgeSnapshotToState(await response.json());
}

function scheduleLibraryStatsHydration() {
  const hydrate = () => {
    els.bookList?.setAttribute("aria-busy", "true");
    hydrateActiveLibraryTexts()
      .then(() => {
        if (state.currentView === "library") render();
      })
      .catch((error) => console.warn("Nie wszystkie książki załadowane:", error))
      .finally(() => els.bookList?.setAttribute("aria-busy", "false"));
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(hydrate, { timeout: 3000 });
  } else {
    setTimeout(hydrate, 500);
  }
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
    applyPreferences();
    await loadLocale(state.preferences?.locale || "en");
    applyTranslations();
    applyPlatformUi();
    await loadBooksCatalog();
    ensureCurrentText();
    bindEvents();
    bindLibraryEvents();
    import("./js/views/reader.js").then(m => m.bindReaderEvents());
    applyPreferences();
    syncSettingsControls();
    applyPlatformUi();
    render();
    showLanguageOnboardingIfNeeded();
    scheduleLibraryStatsHydration();
  } catch (error) {
    reportClientError(`Startup failed: ${error?.stack || error}`, error);
  } finally {
    document.documentElement.classList.remove("app-booting");
  }
    
  import("./js/update-checker.js").then(m => m.checkForUpdates());
});
