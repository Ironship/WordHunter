import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("Android Pocket layout", () => {
  it("turns the Pocket vocabulary table into touch-friendly cards", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const sharedCss = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const vocabList = readFileSync(new URL("../../src/web/js/vocabulary/vocab-list.js", import.meta.url), "utf8");

    assert.match(css, /\.pocket-mode \.table-wrap[\s\S]*overflow: visible/);
    assert.match(css, /\.pocket-mode \.vocab-table[\s\S]*min-width: 0/);
    assert.match(css, /\.pocket-mode \.vocab-table tbody[\s\S]*display: grid/);
    assert.match(css, /\.pocket-mode \.vocab-table tr[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(css, /\.pocket-mode \.vocab-table td:last-child \.row-actions[\s\S]*grid-template-columns: repeat\(4, 44px\)/);
    assert.match(css, /\.pocket-mode \.vocab-table td:last-child \.row-actions \.icon-button[\s\S]*max-width: 44px/);
    assert.match(css, /\.pocket-mode \.vocab-table td:last-child \.row-actions \.icon-button[\s\S]*border-radius: 8px/);
    assert.match(css, /\.pocket-mode #vocabulary-view \.panel-header > div:first-child[\s\S]*display: none/);
    assert.match(css, /\.pocket-mode #vocabulary-view \.vocab-export-actions[\s\S]*grid-template-columns: minmax\(0, 1fr\) 44px 44px/);
    assert.match(css, /\.pocket-mode \.status-check[\s\S]*min-height: 44px/);
    assert.match(css, /\.pocket-mode textarea\.vocab-translation-input[\s\S]*resize: none/);
    assert.match(sharedCss, /textarea\.vocab-translation-input[\s\S]*overflow-wrap: anywhere/);
    assert.match(vocabList, /const pocketMode = document\.documentElement\.classList\.contains\("pocket-mode"\)/);
    assert.match(vocabList, /pocketMode \? `[\s\S]*<textarea[\s\S]*vocab-translation-input/);
  });

  it("keeps Pocket heatmaps scrollable from the first month", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assert.match(css, /\.pocket-mode \.graphs-heatmap,[\s\S]*\.pocket-mode \.review-heatmap[\s\S]*justify-content: flex-start/);
  });

  it("keeps the closed Pocket import drawer out of readable layout", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assert.match(css, /\.pocket-mode \.import-panel[\s\S]*visibility: hidden/);
    assert.match(css, /\.pocket-mode \.import-panel[\s\S]*pointer-events: none/);
    assert.match(css, /\.pocket-mode\.pocket-import-open \.import-panel[\s\S]*visibility: visible/);
    assert.match(css, /\.pocket-mode\.pocket-import-open \.import-panel[\s\S]*pointer-events: auto/);
    assert.match(css, /\.pocket-mode \.pocket-import-toggle[\s\S]*position: fixed/);
    assert.match(css, /\.pocket-mode \.pocket-import-toggle[\s\S]*right: 0/);
    assert.match(css, /\.pocket-mode \.pocket-import-toggle::before[\s\S]*M15%2018l-6-6%206-6/);
    assert.match(css, /\.pocket-mode\[data-view="library"\] \.pocket-import-toggle[\s\S]*display: inline-flex/);
    assert.match(css, /\.pocket-mode \.pocket-drawer-close[\s\S]*display: inline-flex/);
  });

  it("collapses Pocket library search filters behind a touch toggle", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const library = readFileSync(new URL("../../src/web/js/views/library.js", import.meta.url), "utf8");

    assert.match(html, /class="panel library-panel library-filters-collapsed"/);
    assert.match(html, /id="library-filters-toggle"[\s\S]*aria-controls="library-filters"/);
    assert.match(html, /class="filters compact-filters" id="library-filters"/);
    assert.match(css, /\.pocket-mode \.library-filters-toggle[\s\S]*display: inline-flex/);
    assert.match(css, /\.pocket-mode \.library-panel\.library-filters-collapsed \.compact-filters[\s\S]*display: none/);
    assert.match(library, /classList\.toggle\("library-filters-collapsed", !expanded\)/);
    assert.match(library, /setAttribute\("aria-expanded", String\(expanded\)\)/);
  });

  it("keeps Pocket bottom navigation labels inside equal columns", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assert.match(css, /\.pocket-mode \.nav-list[\s\S]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.pocket-mode \.nav-list[\s\S]*align-items: stretch/);
    assert.match(css, /\.pocket-mode \.nav-item[\s\S]*align-content: center/);
    assert.match(css, /\.pocket-mode \.nav-item[\s\S]*max-width: 100%/);
    assert.match(css, /\.pocket-mode \.nav-item[\s\S]*overflow: hidden/);
    assert.match(css, /\.pocket-mode \.nav-item > span:not\(\.nav-icon\):not\(\.shortcut-badge\)[\s\S]*overflow-wrap: anywhere/);
    assert.match(css, /\.pocket-mode \.nav-item > span:not\(\.nav-icon\):not\(\.shortcut-badge\)[\s\S]*word-break: break-word/);
  });

  it("keeps Pocket flashcard actions and settings toggles finger sized", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assert.match(css, /\.pocket-mode #flashcards-view \.word-actions[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.pocket-mode #flashcards-view \.word-actions \.secondary-button[\s\S]*min-height: 44px/);
    assert.match(css, /\.pocket-mode #flashcards-view \[data-tts-word\]\.secondary-button[\s\S]*width: 44px !important/);
    assert.match(css, /\.pocket-mode #flashcards-view \[data-tts-word\]\.secondary-button[\s\S]*flex: 0 0 44px !important/);
    assert.match(css, /\.pocket-mode \.setting-row input\[type="checkbox"\][\s\S]*width: 68px/);
    assert.match(css, /\.pocket-mode \.setting-row input\[type="checkbox"\][\s\S]*height: 40px/);
  });

  it("keeps common text colors readable in Pocket light and dark themes", () => {
    const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");

    assert.match(css, /--muted: #626b65/);
    assert.match(css, /--green: #23694d/);
    assert.match(css, /--amber: #8f5f18/);
    assert.match(css, /:root\[data-theme="dark"\] \.primary-button[\s\S]*color: #082018/);
    assert.match(css, /:root\[data-theme="dark"\] \.secondary-button,[\s\S]*background: #1e252a/);
    assert.match(css, /:root\[data-theme="dark"\] \.status-button\.status-known\.active[\s\S]*color: #a8f0d3/);
  });

  it("keeps settings color pickers circular in Pocket WebView", () => {
    const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const pocketCss = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assert.match(css, /\.color-picker-lg[\s\S]*aspect-ratio: 1/);
    assert.match(css, /\.color-picker-lg[\s\S]*overflow: hidden/);
    assert.match(css, /\.color-picker-lg::-webkit-color-swatch-wrapper[\s\S]*padding: 0/);
    assert.match(css, /\.color-picker-lg::-webkit-color-swatch[\s\S]*width: 100%/);
    assert.match(css, /\.color-picker-lg::-webkit-color-swatch[\s\S]*height: 100%/);
    assert.match(pocketCss, /\.pocket-mode input\.color-picker-lg[\s\S]*min-height: var\(--color-picker-size\)/);
  });
});
