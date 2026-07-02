import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
const pocketCss = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
const desktopWindow = readFileSync(new URL("../../src-tauri/src/platform/web_app.rs", import.meta.url), "utf8");
const cargoToml = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const flatpakDesktop = readFileSync(new URL("../../flatpak/com.wordhunter.app.desktop", import.meta.url), "utf8");
const flatpakMeta = readFileSync(new URL("../../flatpak/com.wordhunter.app.metainfo.xml", import.meta.url), "utf8");
const flatpakManifest = readFileSync(new URL("../../com.wordhunter.app.yml", import.meta.url), "utf8");

describe("desktop reader UX", () => {
  it("keeps a desktop-only reader focus mode behind a user preference", async () => {
    const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
    const { normalizeState } = await import("../../src/web/js/state/normalize.js");

    assert.match(html, /class="setting-row toggle-row desktop-only-setting"[\s\S]*id="pref-reader-focus-mode"/);
    assert.match(css, /:root\.reader-focus-mode:not\(\.pocket-mode\)\[data-view="reader"\] \.topbar/);
    assert.match(css, /:root\.reader-focus-mode:not\(\.pocket-mode\)\[data-view="reader"\] \.reader-meta/);
    assert.match(css, /:root\.reader-focus-mode:not\(\.pocket-mode\)\[data-view="reader"\] \.focus-hint/);
    assert.equal(createDefaultState().preferences.readerFocusMode, false);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { readerFocusMode: "yes" } }).preferences.readerFocusMode, false);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { readerFocusMode: true } }).preferences.readerFocusMode, true);
  });

  it("wires the focus-mode preference through DOM cache, settings events, and CSS class application", () => {
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");

    assert.match(dom, /prefReaderFocusMode = document\.getElementById\("pref-reader-focus-mode"\)/);
    assert.match(html, /id="pref-reader-focus-mode"[^>]*data-pref="readerFocusMode"/);
    assert.match(settings, /querySelectorAll\("\[data-pref\]"\)/);
    assert.match(settings, /updatePreferenceValue\(\s*control\.dataset\.pref,[\s\S]*control\.type === "checkbox" \? control\.checked : control\.value/);
    assert.match(preferences, /classList\.toggle\("reader-focus-mode", prefs\.readerFocusMode === true && !isAndroidPlatform\(\)\)/);
    assert.match(preferences, /prefReaderFocusMode[\s\S]*checked = prefs\.readerFocusMode === true/);
  });

  it("adds a desktop word-panel toggle and keeps the setting persistent", async () => {
    const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
    const { normalizeState } = await import("../../src/web/js/state/normalize.js");
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");
    const globalActions = readFileSync(new URL("../../src/web/js/events/global-actions.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");
    const wordPanelToggle = html.match(/<button[^>]*id="reader-word-panel-toggle"[\s\S]*?<\/button>/)?.[0] || "";

    assert.match(html, /id="reader-word-panel-toggle"[\s\S]*desktop-only-control/);
    assert.doesNotMatch(wordPanelToggle, /<svg/);
    assert.match(wordPanelToggle, /&gt;&gt;/);
    assert.match(html, /id="pref-reader-word-panel-visible"/);
    assert.match(css, /:root\.reader-word-panel-hidden:not\(\.pocket-mode\)\[data-view="reader"\] \.reader-grid/);
    assert.match(css, /\.reader-sidebar-resizer,[\s\S]*\.reader-sidebar-wrapper\s*{\s*display: none;/);
    assert.match(dom, /readerWordPanelToggle = document\.getElementById\("reader-word-panel-toggle"\)/);
    assert.match(dom, /prefReaderWordPanelVisible = document\.getElementById\("pref-reader-word-panel-visible"\)/);
    assert.match(html, /id="pref-reader-word-panel-visible"[^>]*data-pref="readerWordPanelVisible"/);
    assert.match(settings, /querySelectorAll\("\[data-pref\]"\)/);
    assert.match(globalActions, /reader-word-panel-toggle[\s\S]*updatePreferenceValue\("readerWordPanelVisible", state\.preferences\.readerWordPanelVisible === false\)/);
    assert.match(preferences, /classList\.toggle\("reader-word-panel-hidden", prefs\.readerWordPanelVisible === false && !isAndroidPlatform\(\)\)/);
    assert.match(preferences, /readerWordPanelToggle[\s\S]*aria-pressed/);
    assert.match(preferences, /textContent = t\(visible \? "settings\.readerWordPanelHideControl" : "settings\.readerWordPanelShowControl"\)/);
    assert.equal(createDefaultState().preferences.readerWordPanelVisible, true);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { readerWordPanelVisible: false } }).preferences.readerWordPanelVisible, false);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { readerWordPanelVisible: "no" } }).preferences.readerWordPanelVisible, true);
  });

  it("keeps the desktop word panel open while its controls are used", () => {
    const readerEvents = readFileSync(new URL("../../src/web/js/views/reader.js", import.meta.url), "utf8");

    assert.match(readerEvents, /lastWordPanelInteractionAt/);
    assert.match(readerEvents, /els\.wordPanel\.addEventListener\("pointerdown", rememberWordPanelInteraction\)/);
    assert.match(readerEvents, /Date\.now\(\) - lastWordPanelInteractionAt < 700/);
    assert.match(readerEvents, /active\.closest\?\.\("#reader-text \.word-token, #word-panel"\)/);
  });

  it("adds a reader highlight toggle wired to the existing highlight preference", () => {
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const globalActions = readFileSync(new URL("../../src/web/js/events/global-actions.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");

    assert.match(html, /id="reader-highlight-toggle"[\s\S]*aria-pressed="true"/);
    assert.match(dom, /readerHighlightToggle = document\.getElementById\("reader-highlight-toggle"\)/);
    assert.match(globalActions, /reader-highlight-toggle[\s\S]*updatePreferenceValue\("highlightTokens", state\.preferences\.highlightTokens === false\)/);
    assert.match(preferences, /readerHighlightToggle[\s\S]*aria-pressed/);
    assert.match(css, /#reader-highlight-toggle\[aria-pressed="true"\],[\s\S]*#reader-word-panel-toggle\[aria-pressed="true"\]/);
  });

  it("adds larger desktop controls as an explicit laptop/tablet option", async () => {
    const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
    const { normalizeState } = await import("../../src/web/js/state/normalize.js");
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");

    assert.match(html, /class="setting-row toggle-row desktop-only-setting"[\s\S]*id="pref-touch-controls"/);
    assert.match(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) \.primary-button/);
    assert.match(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) \.nav-item/);
    assert.match(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) \.status-check/);
    assert.match(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) \.toast-close/);
    assert.match(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) button\[data-action="remove-image"\]/);
    assert.doesNotMatch(css, /:root\.touch-controls-mode:not\(\.pocket-mode\) button\s*{/);
    assert.match(css, /min-height: 44px/);
    assert.match(dom, /prefTouchControls = document\.getElementById\("pref-touch-controls"\)/);
    assert.match(html, /id="pref-touch-controls"[^>]*data-pref="touchControls"/);
    assert.match(settings, /querySelectorAll\("\[data-pref\]"\)/);
    assert.match(preferences, /classList\.toggle\("touch-controls-mode", prefs\.touchControls === true && !isAndroidPlatform\(\)\)/);
    assert.equal(createDefaultState().preferences.touchControls, false);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { touchControls: true } }).preferences.touchControls, true);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { touchControls: "true" } }).preferences.touchControls, false);
  });

  it("keeps form controls themed in WebKitGTK dark mode", () => {
    assert.match(css, /:root\s*{[\s\S]*color-scheme: light/);
    assert.match(css, /:root\[data-theme="dark"\]\s*{[\s\S]*color-scheme: dark/);
    assert.match(css, /input,\s*select,\s*textarea\s*{[\s\S]*background: var\(--panel\)/);
    assert.match(css, /select\s*{[\s\S]*-webkit-appearance: none/);
    assert.match(css, /select\s*{[\s\S]*background-image: var\(--select-arrow\)/);
    assert.match(css, /select option,\s*select optgroup\s*{[\s\S]*background: var\(--panel\)/);
    assert.doesNotMatch(css, /input,\s*select,\s*textarea\s*{[\s\S]*background:\s*#ffffff/);
  });

  it("keeps Linux windows matched to the Word Hunter desktop icon", () => {
    assert.equal(tauriConfig.identifier, "com.wordhunter.app");
    assert.equal(tauriConfig.app.enableGTKAppId, true);
    assert.match(flatpakDesktop, /^Icon=com\.wordhunter\.app$/m);
    assert.match(flatpakDesktop, /^StartupWMClass=com\.wordhunter\.app$/m);
    assert.match(flatpakMeta, /<icon type="stock">com\.wordhunter\.app<\/icon>/);
    assert.match(flatpakMeta, /<category>Education<\/category>/);
    assert.match(flatpakMeta, /<category>Languages<\/category>/);
    assert.match(cargoToml, /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\][\s\S]*gdkwayland-sys = \{ version = "0\.18", features = \["v3_24_22"\] \}/);
    assert.match(desktopWindow, /const LINUX_DESKTOP_APP_ID: &str = "com\.wordhunter\.app"/);
    assert.match(desktopWindow, /set_linux_program_name\(\)/);
    assert.match(desktopWindow, /g_set_prgname\(app_id\.as_ptr\(\)\)/);
    assert.match(desktopWindow, /install_wayland_app_id\(&window\)/);
    assert.match(desktopWindow, /gdk_wayland_window_set_application_id/);
  });

  it("wires optional TTS word highlighting without enabling it by default", async () => {
    const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
    const { normalizeState } = await import("../../src/web/js/state/normalize.js");
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");

    assert.match(html, /id="pref-tts-word-highlight"/);
    assert.match(dom, /prefTtsWordHighlight = document\.getElementById\("pref-tts-word-highlight"\)/);
    assert.match(html, /id="pref-tts-word-highlight"[^>]*data-pref="ttsWordHighlight"/);
    assert.match(settings, /querySelectorAll\("\[data-pref\]"\)/);
    assert.match(preferences, /prefTtsWordHighlight[\s\S]*checked = prefs\.ttsWordHighlight === true/);
    assert.match(css, /\.word-token\.tts-current-word[\s\S]*outline: 2px solid var\(--amber\)/);
    assert.equal(createDefaultState().preferences.ttsWordHighlight, false);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { ttsWordHighlight: true } }).preferences.ttsWordHighlight, true);
    assert.equal(normalizeState({ ...createDefaultState(), preferences: { ttsWordHighlight: "true" } }).preferences.ttsWordHighlight, false);
  });

  it("keeps desktop language, Help, and Gutenberg discovery visible outside Pocket-only navigation", () => {
    assert.match(html, /data-view="discover"/);
    assert.match(html, /id="discover-view"/);
    assert.match(html, /option value="gutenberg"/);
    assert.match(html, /data-view="help"/);
    assert.match(html, /id="help-view"/);
    assert.match(html, /id="pref-locale-sidebar"/);
    assert.match(html, /id="pref-learning-language-sidebar"/);
    assert.match(html, /data-language-flag="locale"/);
    assert.match(html, /data-language-flag="learning"/);
  });

  it("keeps Pocket-only library drawer controls hidden on desktop", () => {
    assert.match(html, /id="library-import-toggle"[\s\S]*pocket-import-toggle/);
    assert.match(html, /id="library-import-close"[\s\S]*pocket-drawer-close/);
    assert.match(css, /:root:not\(\.pocket-mode\) button\.pocket-import-toggle,[\s\S]*:root:not\(\.pocket-mode\) button\.pocket-drawer-close\s*{\s*display: none;/);
  });

  it("keeps desktop library filters in one compact header row", () => {
    assert.match(css, /\.library-panel > \.panel-header\s*{[\s\S]*display: flex;[\s\S]*align-items: flex-end;[\s\S]*flex-wrap: nowrap;/);
    assert.match(css, /button\.library-filters-toggle\s*{\s*display: none;/);
    assert.match(css, /\.library-panel \.compact-filters\s*{[\s\S]*flex-wrap: nowrap;[\s\S]*align-items: flex-end;[\s\S]*min-width: 0;/);
    assert.match(pocketCss, /\.pocket-mode \.library-filters-toggle[\s\S]*display: inline-flex/);
  });

  it("ships desktop reader focus copy in every locale", () => {
    for (const code of ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"]) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${code}.json`, import.meta.url), "utf8"));
      assert.equal(typeof dict.settings.readerFocusMode, "string", `${code}.settings.readerFocusMode`);
      assert.equal(typeof dict.settings.readerFocusModeHint, "string", `${code}.settings.readerFocusModeHint`);
      assert.equal(typeof dict.settings.readerWordPanelVisible, "string", `${code}.settings.readerWordPanelVisible`);
      assert.equal(typeof dict.settings.readerWordPanelVisibleHint, "string", `${code}.settings.readerWordPanelVisibleHint`);
      assert.equal(typeof dict.settings.readerWordPanelHideControl, "string", `${code}.settings.readerWordPanelHideControl`);
      assert.equal(typeof dict.settings.readerWordPanelShowControl, "string", `${code}.settings.readerWordPanelShowControl`);
      assert.equal(typeof dict.settings.touchControls, "string", `${code}.settings.touchControls`);
      assert.equal(typeof dict.settings.touchControlsHint, "string", `${code}.settings.touchControlsHint`);
      assert.equal(typeof dict.settings.ttsWordHighlight, "string", `${code}.settings.ttsWordHighlight`);
      assert.equal(typeof dict.settings.ttsWordHighlightHint, "string", `${code}.settings.ttsWordHighlightHint`);
      for (const key of ["groupLanguage", "groupLearningDisplay", "groupReader", "groupTts", "groupSync", "groupBackup"]) {
        assert.equal(typeof dict.settings[key], "string", `${code}.settings.${key}`);
      }
    }
  });

  it("visibly splits Settings into platform-relevant groups", () => {
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupLanguage"/);
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupLearningDisplay"/);
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupReader"/);
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupTts"/);
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupSync"/);
    assert.match(html, /class="settings-subheading" data-i18n="settings\.groupBackup"/);
    assert.match(css, /\.settings-subheading[\s\S]*text-transform: uppercase/);
  });

  it("keeps the desktop edit-book dialog controls visible and the cover clear button square", () => {
    assert.match(html, /id="edit-book-dialog" class="panel edit-book-dialog"/);
    assert.match(html, /class="settings-body edit-book-body"/);
    assert.match(html, /class="edit-book-actions"[\s\S]*id="edit-book-save"/);
    assert.match(html, /id="edit-book-cover-clear" class="edit-book-cover-clear"/);
    assert.match(css, /\.edit-book-dialog\[open\]\s*{[\s\S]*display: flex;[\s\S]*flex-direction: column;/);
    assert.match(css, /\.edit-book-body\s*{[\s\S]*overflow-y: auto;/);
    assert.match(css, /\.edit-book-actions\s*{[\s\S]*position: sticky;[\s\S]*bottom: 0;/);
    assert.match(css, /\.edit-book-cover-clear\s*{[\s\S]*width: 24px;[\s\S]*height: 24px;[\s\S]*aspect-ratio: 1;/);
  });

  it("keeps desktop vocabulary actions visible over examples in narrow windows", () => {
    assert.match(css, /\.vocab-table\s*{[\s\S]*min-width: 1260px;[\s\S]*table-layout: fixed;/);
    assert.match(css, /\.vocab-table th:nth-child\(4\)\s*{\s*width: 320px;\s*}/);
    assert.match(css, /\.vocab-table th:nth-child\(5\)\s*{\s*width: 340px;\s*}/);
    assert.match(css, /\.vocab-table td:last-child\s*{[\s\S]*position: sticky;[\s\S]*right: 0;[\s\S]*width: 340px;/);
    assert.match(css, /\.vocab-table th:last-child\s*{[\s\S]*position: sticky;[\s\S]*right: 0;/);
    assert.match(pocketCss, /\.pocket-mode \.vocab-table th:last-child,\s*\.pocket-mode \.vocab-table td:last-child\s*{[\s\S]*position: static;[\s\S]*right: auto;/);
    assert.match(pocketCss, /\.pocket-mode \.vocab-table\s*{[\s\S]*min-width: 0;/);
    assert.match(desktopWindow, /\.min_inner_size\(960\.0, 640\.0\)/);
  });

  it("keeps in-text SRS grade colors visible on desktop hover", () => {
    assert.doesNotMatch(css, /\.sm2-grade:hover\s*{[\s\S]*background: var\(--panel-strong\)/);
    assert.match(css, /\.sm2-grades \.status-button\.sm2-grade-1:hover[\s\S]*background: var\(--red-soft\)/);
    assert.match(css, /\.sm2-grades \.status-button\.sm2-grade-3:hover[\s\S]*background: var\(--amber-soft\)/);
    assert.match(css, /\.sm2-grades \.status-button\.sm2-grade-5:hover[\s\S]*background: var\(--green-soft\)/);
    assert.match(css, /:root\[data-theme="dark"\] \.sm2-grades \.status-button\.sm2-grade-1:hover/);
  });

  it("keeps PDF OCR marks compact without rendering OCR text", () => {
    const pdfOcrRenderer = readFileSync(new URL("../../src/web/js/reader/pdf-ocr-renderer.js", import.meta.url), "utf8");
    const defaults = readFileSync(new URL("../../src/web/js/state/defaults.js", import.meta.url), "utf8");
    const normalize = readFileSync(new URL("../../src/web/js/state/normalize.js", import.meta.url), "utf8");

    assert.match(css, /\.word-token\.status-new\s*{[\s\S]*box-shadow: inset 0 -0\.28em var\(--token-new-bg, var\(--amber-soft\)\);/);
    assert.match(css, /\.pdf-ocr-toolbar\s*{[\s\S]*position: sticky;[\s\S]*justify-content: flex-end;/);
    assert.match(css, /\.reader-text\.pdf-text-layer-reader\s*{[\s\S]*white-space: pre-wrap;/);
    assert.match(css, /\.pdf-text-page\s*{[\s\S]*width: min\(100%, 920px\);[\s\S]*margin: 0 auto;/);
    assert.match(css, /\.pdf-ocr-stage\s*{[\s\S]*justify-items: center;[\s\S]*touch-action: pan-x pan-y;/);
    assert.match(css, /\.pdf-ocr-page\s*{[\s\S]*min-width: min\(100%, 240px\);[\s\S]*max-width: none;/);
    assert.match(css, /\.word-token\.pdf-ocr-word\s*{[\s\S]*--pdf-ocr-mark-height: clamp\(1px, 8%, 3px\);[\s\S]*--pdf-ocr-mark-bottom: 6%;[\s\S]*box-shadow: none !important;[\s\S]*font-size: 0;[\s\S]*line-height: 0;/);
    assert.match(css, /\.word-token\.pdf-ocr-word::after\s*{[\s\S]*bottom: var\(--pdf-ocr-mark-bottom\);[\s\S]*height: var\(--pdf-ocr-mark-height\);[\s\S]*border-radius: 999px;/);
    assert.doesNotMatch(css, /\.word-token\.pdf-ocr-word::after\s*{[\s\S]*bottom: 0;[\s\S]*height: clamp\(2px, 16%, 6px\);/);
    assert.doesNotMatch(css, /\.word-token\.pdf-ocr-word::after\s*{[\s\S]*bottom: calc\(-1 \* var\(--pdf-ocr-mark-offset\)\);/);
    assert.match(css, /\.word-token\.pdf-ocr-word\.status-new::after\s*{[\s\S]*background: var\(--token-new-bg, var\(--amber-soft\)\);/);
    assert.match(defaults, /readerPdfZoom: 1/);
    assert.match(defaults, /readerPdfViewMode: "overlay"/);
    assert.match(normalize, /nextState\.readerPdfZoom = clamp\(Number\(nextState\.readerPdfZoom\) \|\| 1, 0\.75, 3\)/);
    assert.match(normalize, /nextState\.readerPdfViewMode = nextState\.readerPdfViewMode === "text" \? "text" : "overlay"/);
    assert.match(pdfOcrRenderer, /if \(pageWords\.length\) return pageWords;/);
    assert.match(pdfOcrRenderer, /PDF_TEXT_LAYER_BOUNDS_VERSION = "text-glyph-v2"/);
    assert.match(pdfOcrRenderer, /PDF_OCR_ZOOM_MIN = 0\.75/);
    assert.match(pdfOcrRenderer, /PDF_OCR_ZOOM_MAX = 3/);
    assert.match(pdfOcrRenderer, /export function setPdfOcrViewMode\(value, options = \{\}\)/);
    assert.match(pdfOcrRenderer, /els\.readerText\.classList\.toggle\("pdf-text-layer-reader", !overlayMode\)/);
    assert.match(pdfOcrRenderer, /function renderPdfOcrTextMode\(current, page, globalOffset, totalPages, scrollPerPageKey, savedPos\)/);
    assert.match(pdfOcrRenderer, /<div class="pdf-text-page" aria-label="\$\{escapeAttribute\(t\("reader\.pdfTextPageLabel"/);
    assert.match(pdfOcrRenderer, /export function setPdfOcrZoom\(value, options = \{\}\)/);
    assert.match(pdfOcrRenderer, /function pdfOcrZoomLayout\(zoom\)/);
    assert.match(pdfOcrRenderer, /stageScale = Math\.max\(1, normalized\)/);
    assert.match(pdfOcrRenderer, /pageScale = normalized \/ stageScale/);
    assert.match(pdfOcrRenderer, /data-pdf-view-mode="\$\{escapeAttribute\(targetMode\)\}"/);
    assert.match(pdfOcrRenderer, /data-pdf-zoom="out"/);
    assert.match(pdfOcrRenderer, /data-pdf-zoom="reset"/);
    assert.match(pdfOcrRenderer, /data-pdf-zoom="in"/);
    assert.match(pdfOcrRenderer, /<div class="pdf-ocr-stage" style="width:\$\{stageWidthPercent\}%;">/);
    assert.match(pdfOcrRenderer, /stage\.style\.width = `\$\{layout\.stageWidthPercent\}%`/);
    assert.match(pdfOcrRenderer, /width:\$\{pageWidthPercent\}%/);
    assert.match(pdfOcrRenderer, /usesLegacyPdfTextLayerBounds\(page, current\)/);
    assert.match(pdfOcrRenderer, /engine\.includes\("pdf-text-layer"\) \|\| engine\.includes\("pdfium-text-layer"\)/);
    assert.match(pdfOcrRenderer, /aria-label="\$\{escapeAttribute\(raw\)\}"><\/button>`/);
    assert.match(pdfOcrRenderer, /function renderPdfOcrTextTokens\(tokens, globalOffset\)[\s\S]*\$\{escapeHtml\(raw\)\}/);
    assert.doesNotMatch(html, /reader-pdf-ocr-line-spacing-slider/);
    assert.doesNotMatch(css, /reader-ocr-line/);
    for (const code of ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"]) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${code}.json`, import.meta.url), "utf8"));
      for (const key of ["pdfZoomLabel", "pdfZoomIn", "pdfZoomOut", "pdfZoomReset", "pdfViewModeLabel", "pdfShowText", "pdfShowBackground", "pdfTextPageLabel"]) {
        assert.equal(typeof dict.reader[key], "string", `${code}.reader.${key}`);
      }
    }
  });

  it("falls back to a rendered PDF text layer when the desktop OCR runner is unavailable", () => {
    const pdfOcrBackend = readFileSync(new URL("../../src-tauri/src/pdf_ocr/mod.rs", import.meta.url), "utf8");

    assert.match(cargoToml, /\[dependencies\][\s\S]*pdf-extract = "0\.12"/);
    assert.match(flatpakManifest, /--filesystem=host-os:ro/);
    assert.match(pdfOcrBackend, /Err\(runner_error\) => \{[\s\S]*import_text_layer_pdf\(\s*filename,\s*&data,\s*max_pages,\s*&runner_error,\s*store,\s*book_id,\s*\)/);
    assert.match(pdfOcrBackend, /pdf_extract::output_doc_page\(&document, &mut output, page_num\)/);
    assert.match(pdfOcrBackend, /pdf_extract::extract_text_from_mem_by_pages\(data\)/);
    assert.match(pdfOcrBackend, /merge_words_using_plain_text\(/);
    assert.match(pdfOcrBackend, /lookup_text\.contains\(&joined\) && !lookup_text\.contains\(&spaced\)/);
    assert.match(pdfOcrBackend, /let baseline_y = position\.m32 as f32;/);
    assert.match(pdfOcrBackend, /let y_top = baseline_y - font_height \* 0\.82;/);
    assert.match(pdfOcrBackend, /bounds_version: TEXT_LAYER_BOUNDS_VERSION/);
    assert.doesNotMatch(pdfOcrBackend, /marker_room/);
    assert.match(pdfOcrBackend, /render_text_layer_page_images\(data, store, book_id, &pages\)/);
    assert.match(pdfOcrBackend, /PathBuf::from\("\/run\/host\/usr\/bin\/pdftoppm"\)/);
    assert.match(pdfOcrBackend, /store\.save_book_image_bytes\(book_id, &page\.image_name, &image_bytes\)/);
    assert.match(pdfOcrBackend, /"ocrEngine": "pdf-text-layer\+pdftoppm"/);
    assert.match(pdfOcrBackend, /"pages": pages/);
  });
});
