// Punkt wejścia aplikacji. Składa moduły, nie zawiera logiki domenowej.
import { cacheElements } from "./js/dom.js";
import "./js/toast.js";
import "./js/events.js";
import { bindEvents } from "./js/events.js";
import { applyPreferences, syncSettingsControls } from "./js/preferences.js";
import { loadBooksCatalog, loadAllBookTexts, loadAllCustomTextContents } from "./js/books.js";
import { render, ensureCurrentText } from "./js/render.js";
import { loadLocale, applyTranslations, t } from "./js/i18n.js";
import { state } from "./js/state.js";
import { bindLibraryEvents } from "./js/views/library.js";

window.onerror = function(msg, url, line, col, error) {
  const errDiv = document.createElement("div");
  errDiv.style = "position:fixed;top:0;left:0;right:0;background:red;color:white;z-index:9999;padding:1rem;";
  errDiv.textContent = t("app.jsError", { msg, url, line, col, stack: error?.stack || "" });
  document.body.appendChild(errDiv);
  try {
    fetch("/__log_error", { method: "POST", body: errDiv.textContent });
  } catch(e) {}
};

window.addEventListener("unhandledrejection", function(event) {
  const errDiv = document.createElement("div");
  errDiv.style = "position:fixed;top:0;left:0;right:0;background:orange;color:white;z-index:9999;padding:1rem;margin-top:3rem;";
  errDiv.textContent = t("app.unhandledPromise", { reason: event.reason });
  document.body.appendChild(errDiv);
});

document.addEventListener("contextmenu", event => event.preventDefault());

// Start locale fetch immediately (module-level, before DOMContentLoaded)
const _localePromise = loadLocale(state.preferences?.locale || "en");

function scheduleLibraryStatsHydration() {
  const hydrate = () => {
    Promise.all([loadAllBookTexts(), loadAllCustomTextContents()])
      .then(() => {
        if (state.currentView === "library") render();
      })
      .catch((error) => console.warn("Nie wszystkie książki załadowane:", error));
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(hydrate, { timeout: 3000 });
  } else {
    setTimeout(hydrate, 500);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  await _localePromise;
  applyTranslations();
  await loadBooksCatalog();
  ensureCurrentText();
  bindEvents();
  bindLibraryEvents();
  import("./js/views/reader.js").then(m => m.bindReaderEvents());
  applyPreferences();
  syncSettingsControls();
  render();
  scheduleLibraryStatsHydration();
    
  import("./js/update-checker.js").then(m => m.checkForUpdates());

  const reloadBtn = document.getElementById("app-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", () => window.location.reload());
  const reloadBtnOld = document.getElementById("reload-btn");
  if (reloadBtnOld) reloadBtnOld.remove();
});
