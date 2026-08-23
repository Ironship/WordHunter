// Boot-time Settings DOM builders split out of the former monolithic
// events/settings.ts: the Argos download dialog and the Settings view shell.
// Both are called during app boot before cacheElements() (app.ts); every
// consumer resolves the elements via getElementById after boot, so boot
// order guarantees they exist.
import { SETTINGS_VIEW_HTML } from "../settings-view-template.js";

/**
 * Builds the offline-model download dialog markup once (idempotent). Called
 * during app boot before cacheElements() (app.ts); bindSettingsEvents()
 * resolves the elements via getElementById, so boot order guarantees they
 * exist.
 */
export function renderArgosDownloadDialog(): HTMLDialogElement {
  const existing = document.getElementById("argos-download-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#argos-download-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "argos-download-dialog";
  dialog.className = "panel dialog-500";
  dialog.setAttribute("aria-labelledby", "argos-download-title");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 id="argos-download-title" data-i18n="settings.argosDownloadTitle">Download offline models</h2>
    </div>
    <div class="settings-body p-15-g-1">
      <p class="muted-copy" data-i18n="settings.argosDownloadHint">Downloads local translation packages for the selected languages, including pairs with English and your learning language when available.</p>
      <div id="argos-languages-list" class="stack-g-05">
        <label class="status-check justify-start">
          <input type="checkbox" value="en" checked>
          <span data-i18n="languages.en">English</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="pl" checked>
          <span data-i18n="languages.pl">Polish</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="de">
          <span data-i18n="languages.de">German</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="es">
          <span data-i18n="languages.es">Spanish</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="fr">
          <span data-i18n="languages.fr">French</span>
        </label>
        <label class="status-check justify-start">
          <input type="checkbox" value="zh">
          <span data-i18n="languages.zh">Chinese (Simplified)</span>
        </label>
      </div>
      <p data-i18n="settings.argosDownloadWarning" class="error-text">Note: downloading models will take a while. Do not close the app during the process.</p>
      <div class="justify-end-m-t-1">
        <button id="argos-download-cancel" class="secondary-button" data-i18n="moveBook.cancel">Cancel</button>
        <button id="argos-download-confirm" class="primary-button" data-i18n="settings.argosDownloadConfirm">Download</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

/**
 * Builds the Settings view shell and the phase-1 general panels (Appearance,
 * Flashcards, AI explanations, Local data) once (idempotent). Called during
 * app boot before cacheElements() (app.ts); every consumer resolves the
 * elements via getElementById after boot, so boot order guarantees they
 * exist. The Reader and Translator & Dictionary panels stay static in
 * index.html for phase 2 of the #127 P3 port.
 */
export function renderSettingsView(): HTMLElement {
  const existing = document.getElementById("settings-view");
  if (existing instanceof HTMLElement) return existing;
  if (existing) throw new TypeError("#settings-view must be an element");

  const view = document.createElement("section");
  view.id = "settings-view";
  view.className = "view";
  view.setAttribute("data-title-key", "nav.settings");
  view.innerHTML = SETTINGS_VIEW_HTML;
  // Mount inside .main-panel like the other views — appending to document.body
  // puts the view below the app shell (below the fold), making the Settings
  // tab look empty until the user scrolls.
  const host = document.querySelector<HTMLElement>("main.main-panel") ?? document.body;
  host.appendChild(view);
  return view;
}
