// Renders the static import panel markup (idempotent).
import { t } from "../../i18n.js";
import { registerUnsavedDialog } from "../../dialog-backdrop.js";
import { beginElementBusy } from "../../loading.js";
import {
  clearPendingImportMeta,
  resetCoverPreview,
} from "./shared.js";

export function renderImportPanel(): HTMLElement {
  const existing = document.getElementById("import-panel");
  if (existing) return existing;
  const host = document.querySelector(".workspace-grid.library-layout");
  if (!host) throw new TypeError("Missing library workspace grid for import panel");
  const panel = document.createElement("aside");
  panel.id = "import-panel";
  panel.className = "panel import-panel";
  panel.setAttribute("aria-labelledby", "import-heading");
  panel.innerHTML = `
    <div class="panel-header stacked">
      <p class="eyebrow" data-i18n="import.eyebrow">Custom text</p>
      <h2 id="import-heading" data-i18n="import.heading">Import</h2>
      <button type="button" id="library-import-close" class="icon-button pocket-drawer-close" data-i18n-attr="title=reader.close,aria-label=reader.close" aria-label="Close">×</button>
    </div>
    <div class="import-mode-row">
      <label for="import-mode-select">
        <span data-i18n="import.modeLabel">Import type</span>
        <select id="import-mode-select" class="input">
          <option value="books" data-i18n="import.modeBooks">Import books / texts</option>
          <option value="youtube" data-i18n="import.modeYoutube">Import YouTube subtitles</option>
        </select>
      </label>
    </div>
    <div id="import-books-mode">
      <form id="import-form" class="import-form">
        <label class="file-button">
          <span data-i18n="import.fileLabel">Import books / texts</span>
          <input id="import-file" type="file" accept=".txt,.md,.markdown,.srt,.vtt,.ass,.ssa,.epub,.mobi,.azw,.azw3,.pdf,text/plain,text/markdown,text/vtt,application/epub+zip,application/x-mobipocket-ebook,application/pdf">
        </label>
        <p class="muted-copy" id="import-file-hint" data-i18n-html="import.desktopOcrUnavailableFileHint"></p>
        <label>
          <span data-i18n="import.title">Title</span>
          <input id="import-title" type="text" data-i18n-attr="placeholder=import.titlePlaceholder" required>
        </label>
        <label>
          <span data-i18n="import.author">Author (optional)</span>
          <input id="import-author" type="text" data-i18n-attr="placeholder=import.authorPlaceholder">
        </label>
        <label>
          <span data-i18n="import.tags">Tags (optional)</span>
          <input id="import-tags" type="text" data-i18n-attr="placeholder=import.tagsPlaceholder">
        </label>
        <label>
          <span data-i18n="import.level">Level (optional)</span>
          <select id="import-level">
            <option value="" data-i18n="library.levelAny">Any</option>
            <option value="A1">A1</option>
            <option value="A2">A2</option>
            <option value="B1">B1</option>
            <option value="B2">B2</option>
            <option value="C1">C1</option>
            <option value="C2">C2</option>
          </select>
        </label>
        <label>
          <span data-i18n="import.text">Text</span>
          <textarea id="import-text" rows="10" spellcheck="false" data-i18n-attr="placeholder=import.textPlaceholder" required></textarea>
        </label>
        <div class="form-group m-b-15-center">
          <label for="import-cover" class="import-cover-dropzone dropzone" id="import-cover-dropzone" data-i18n-attr="title=import.cover">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-32-muted-m-b-05"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <span data-i18n="import.coverPasteHint" class="fs-09-muted">Click to select or paste</span>
            <input id="import-cover" type="file" accept="image/*" class="visually-hidden">
          </label>
        </div>
        <div id="import-cover-preview" class="import-cover-preview m-b-15-w-max" hidden>
          <img id="import-cover-img" data-i18n-attr="alt=import.coverPreviewAlt" alt="Cover preview" class="max-h-150">
          <button type="button" id="import-cover-clear" data-i18n-attr="title=editBook.deleteCover" class="badge-remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-14"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <button class="primary-button" type="submit" id="import-submit" data-i18n="import.submit">Add to library</button>
      </form>
    </div>
    <div id="import-youtube-mode" hidden>
      <section class="youtube-import-section" aria-labelledby="youtube-import-heading">
        <h3 id="youtube-import-heading" data-i18n="import.youtubeHeading">YouTube subtitles</h3>
        <label>
          <span data-i18n="import.youtubeUrl">YouTube URL</span>
          <input id="import-youtube-url" type="url" data-i18n-attr="placeholder=import.youtubePlaceholder">
        </label>
        <div class="youtube-import-actions">
          <select id="import-youtube-track" hidden data-i18n-attr="aria-label=import.youtubeTrack"></select>
          <button class="secondary-button" type="button" id="import-youtube-load" data-i18n="import.youtubeLoad">Load subtitles</button>
        </div>
        <p class="muted-copy" id="import-youtube-status" aria-live="polite"></p>
      </section>
    </div>
  `;
  host.appendChild(panel);
  return panel;
}
