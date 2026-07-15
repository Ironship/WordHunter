import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function declarationBlock(css, selector) {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  const declarations = {};
  let found = false;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((value) => value.replace(/\s+/g, " ").trim());
    if (!selectors.includes(normalizedSelector)) continue;
    found = true;
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  assert.ok(found, `Missing CSS declaration block for ${selector}`);
  return declarations;
}

function assertDeclarations(css, selector, expected) {
  const declarations = declarationBlock(css, selector);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(declarations[property], value, `${selector} ${property}`);
  }
}

describe("Android Pocket reader", () => {
  it("computes page slices used by Pocket reader navigation", async () => {
    globalThis.window = {};
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const { countWordTokens, computePageSlice, computeTotalPages } = await import("../../dist/web/js/reader/pagination.js");
    const tokens = [
      { type: "word", text: "One" },
      { type: "space", text: " " },
      { type: "word", text: "Two" },
      { type: "punct", text: ". " },
      { type: "word", text: "Three" },
      { type: "space", text: " " },
      { type: "word", text: "Four" },
      { type: "space", text: " " },
      { type: "word", text: "Five" }
    ];

    assert.equal(countWordTokens(tokens), 5);
    assert.equal(computeTotalPages(5, 2), 3);
    assert.equal(computeTotalPages(5, 999999), 1);
    assert.deepEqual(computePageSlice(tokens, 1, 2), { pageStartIndex: 0, pageEndIndex: 4 });
    assert.deepEqual(computePageSlice(tokens, 2, 2), { pageStartIndex: 3, pageEndIndex: 8 });
    assert.deepEqual(computePageSlice(tokens, 1, 999999), { pageStartIndex: 0, pageEndIndex: tokens.length });
  });

  it("declares Pocket reader touch and word-panel integration hooks", () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const globalActions = readFileSync(new URL("../../dist/web/js/events/global-actions.js", import.meta.url), "utf8");
    const readerEvents = readFileSync(new URL("../../dist/web/js/views/reader.js", import.meta.url), "utf8");
    const wordPanel = readFileSync(new URL("../../dist/web/js/reader/word-panel.js", import.meta.url), "utf8");
    const selection = readFileSync(new URL("../../dist/web/js/reader/selection.js", import.meta.url), "utf8");
    const shell = readFileSync(new URL("../../dist/web/js/views/shell.js", import.meta.url), "utf8");
    const navigation = readFileSync(new URL("../../dist/web/js/reader/word-navigation.js", import.meta.url), "utf8");
    const platform = readFileSync(new URL("../../dist/web/js/platform.js", import.meta.url), "utf8");

    assert.doesNotMatch(html, /id="reader-vocab-list"/);
    assert.doesNotMatch(globalActions, /reader-vocab-list/);
    assert.match(globalActions, /event\.composedPath/);
    assert.match(globalActions, /clickedReaderSurface/);
    assert.match(readerEvents, /readerText\.addEventListener\("touchstart"/);
    assert.match(readerEvents, /readerText\.addEventListener\("touchmove"/);
    assert.match(readerEvents, /readerText\.addEventListener\("touchend"/);
    assert.match(readerEvents, /beginPdfPinch\(event\)/);
    assert.match(readerEvents, /getPdfOcrViewMode\(\) === "overlay"/);
    assert.match(readerEvents, /shouldReservePdfPan\(event\.target\)/);
    assert.match(readerEvents, /setPdfOcrZoom\(nextZoom, \{ focalClientX: midpoint\.x, focalClientY: midpoint\.y, commit: false \}\)/);
    assert.match(readerEvents, /adjustPdfOcrZoom\(direction \* pdfOcrZoomStep\(\), \{ focalClientX: event\.clientX, focalClientY: event\.clientY \}\)/);
    assert.match(readerEvents, /event\.target\.closest\("\[data-pdf-zoom\]"\)/);
    assert.match(readerEvents, /event\.target\.closest\("\[data-pdf-view-mode\]"\)/);
    assert.match(readerEvents, /setPdfOcrViewMode\(pdfViewModeBtn\.dataset\.pdfViewMode\)/);
    assert.match(html, /id="reader-previous-word"/);
    assert.match(html, /id="reader-next-word"/);
    assert.match(html, /id="pocket-word-panel-sheet-handle"[^>]*aria-controls="word-panel"[^>]*aria-expanded="false"/);
    assert.ok(html.indexOf('id="pocket-word-panel-sheet-handle"') < html.indexOf('id="word-panel"'));
    assert.match(html, /id="pocket-navigation-toggle"/);
    assert.match(html, /id="reader-pocket-navigation-toggle"/);
    assert.doesNotMatch(html, /id="reader-pocket-panel-toggle"/);
    assert.match(shell, /if \(!hasSelectedReaderWord\)\s*document\.documentElement\.classList\.remove\("pocket-word-panel-open"\)/);
    assert.match(readerEvents, /options\.openPanel && document\.documentElement\.classList\.contains\("pocket-mode"\)/);
    assert.match(readerEvents, /openPanel: true/);
    assert.match(navigation, /classList\.remove\("pocket-word-panel-open"\)/);
    assert.match(navigation, /pocketPanelWasOpen/);
    assert.match(navigation, /word-panel-enter-/);
    assert.match(navigation, /word-panel-exit-/);
    assert.match(navigation, /selectWord\(rawWord, normalizeWord/);
    assert.match(navigation, /forceSpeak: true/);
    assert.match(globalActions, /classList\.contains\("pocket-mode"\)/);
    assert.match(readerEvents, /navigateReaderWord\(-1\)/);
    assert.match(readerEvents, /navigateReaderWord\(1\)/);
    assert.match(navigation, /currentIndex === -1 \? \(step > 0 \? 0 : tokens\.length - 1\)/);
    assert.match(readerEvents, /changeReaderPage\(dx < 0 \? 1 : -1\)/);
    assert.match(readerEvents, /isWordPanelOpen\(\)/);
    assert.match(readerEvents, /keepPanelOpen: true/);
    assert.match(readerEvents, /animateDirection: direction > 0 \? "next" : "previous"/);
    assert.match(readerEvents, /persistWord: true/);
    assert.match(readerEvents, /selectWord\(wordToSelect[\s\S]*?if \(openPocketPanel\)\s*refreshPocketWordPanelSheet\(\);/);
    assert.match(readerEvents, /event\.touches\.length !== 1/);
    assert.match(readerEvents, /candidate\.identifier === swipeStart\?\.touchId/);
    assert.match(readerEvents, /\.pagination-controls, a, input, textarea, select, \[contenteditable\]/);
    assert.match(readerEvents, /!card && target\.closest\("button:not\(\.word-token\)"\)/);
    assert.match(readerEvents, /WORD_CARD_SWIPE_DISTANCE = 56/);
    assert.match(readerEvents, /WORD_CARD_SWIPE_AXIS_RATIO = 1\.2/);
    assert.match(readerEvents, /\{ capture: true \}/);
    assert.match(readerEvents, /wordPanel\.addEventListener\("touchmove"/);
    assert.match(readerEvents, /word-panel-card-dragging/);
    assert.match(readerEvents, /wordPanel\.addEventListener\("touchend"/);
    assert.match(platform, /bindPocketWordPanelSheet\(\)/);
    assert.match(platform, /resolvePocketWordSheetState/);
    assert.match(platform, /handle\.addEventListener\("pointermove"/);
    assert.match(wordPanel, /data-close-word-panel/);
    assert.doesNotMatch(wordPanel, /pocket-word-dictionary/);
    assert.equal((wordPanel.match(/data-dict-word=/g) || []).length, 1);
    assert.match(globalActions, /dataset\.dictWord/);
    assert.match(wordPanel, /function bindInTextReviewControls/);
    assert.match(wordPanel, /refreshInTextReview\(entry\)/);
    assert.match(wordPanel, /event\.stopPropagation\(\)/);
    assert.match(selection, /export function clearReaderSelection/);
    assert.match(shell, /document\.documentElement\.dataset\.view = state\.currentView/);
  });

  it("defines scoped Pocket reader layout and status declarations", () => {
    const sharedCss = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, '.pocket-mode[data-view="reader"] .main-panel', { overflow: "hidden", "padding-bottom": "0" });
    assertDeclarations(css, '.pocket-mode[data-view="reader"] .topbar', { display: "none" });
    assertDeclarations(css, '.pocket-mode[data-view="reader"] .reader-toolbar label', { display: "none" });
    assertDeclarations(css, '.pocket-mode[data-view="reader"] .reader-meta > div:first-child', { display: "none" });
    assertDeclarations(css, ".pocket-mode #reader-view.active .pagination-controls", { position: "static", "box-shadow": "none" });
    assertDeclarations(css, ".pocket-mode .word-token", { "touch-action": "manipulation" });
    assertDeclarations(css, ".pocket-mode .reader-text.pdf-ocr-reader", { overflow: "auto", "touch-action": "pan-x pan-y" });
    assert.match(declarationBlock(css, ".pocket-mode .reader-text.pdf-text-layer-reader").padding, /^0\.85rem 1rem/);
    assertDeclarations(css, ".pocket-mode .pdf-ocr-toolbar", { top: "0.35rem" });
    assertDeclarations(css, ".pocket-mode .word-token.pdf-ocr-word", { padding: "0", "border-radius": "5px", "touch-action": "pan-x pan-y" });
    assert.match(declarationBlock(css, ".pocket-mode .word-token.status-new")["box-shadow"], /var\(--token-new-bg/);
    const learningToken = declarationBlock(css, ".pocket-mode .word-token.status-learning");
    assert.match(learningToken["box-shadow"], /var\(--token-learning-bg/);
    assert.equal(learningToken["border-bottom-color"], undefined);
    assertDeclarations(css, ".pocket-mode .shortcut-badge", { display: "none" });
    assertDeclarations(css, ".pocket-mode #reader-view .toolbar-buttons", { position: "fixed", right: "0", bottom: "0", left: "0", "grid-template-columns": "repeat(5, minmax(0, 1fr))", background: "var(--sidebar-bg)", "box-shadow": "0 -12px 28px rgba(0, 0, 0, 0.2)" });
    assertDeclarations(css, ".pocket-mode #reader-view .toolbar-buttons [data-font]", { display: "none" });
    assertDeclarations(css, ".pocket-mode #reader-view .reader-zoom-slider", { display: "none" });
    assertDeclarations(css, ".pocket-mode #reader-view .pocket-word-navigation", { display: "inline-flex", width: "100%", height: "56px" });
    assertDeclarations(css, ".pocket-mode #reader-view .pocket-reader-navigation-toggle", { display: "inline-flex", order: "1", width: "100%", height: "56px" });
    assertDeclarations(css, ".pocket-mode .pocket-navigation-toggle", { position: "fixed", display: "inline-flex", width: "56px" });
    assertDeclarations(css, '.pocket-mode[data-view="reader"] .reader-toolbar', { display: "contents" });
    assert.equal(css.includes("#reader-view #reader-vocab-list"), false);
    const pocketRoot = declarationBlock(css, "html.pocket-mode");
    assert.equal(pocketRoot["--pocket-word-sheet-collapsed-size"], "max(4rem, calc(20dvh - 4.6rem - var(--pocket-navbar-safe-bottom)))");
    const openPanel = declarationBlock(css, ".pocket-mode.has-selected-word.pocket-word-panel-open #reader-view.active .reader-sidebar-wrapper");
    assert.equal(openPanel.top, "calc(var(--pocket-statusbar-safe-top) + 0.5rem)");
    assert.match(openPanel.bottom, /^calc\(4\.6rem/);
    assert.equal(openPanel["max-height"], undefined);
    assert.equal(openPanel.overflow, "hidden");
    assert.equal(openPanel.display, "flex");
    assert.equal(openPanel.gap, "0");
    assert.equal(openPanel["--pocket-word-sheet-collapsed-size"], undefined);
    assert.match(
      declarationBlock(css, '.pocket-mode.has-selected-word.pocket-word-panel-open #reader-view.active .reader-sidebar-wrapper[data-pocket-sheet-state="collapsed"]').top,
      /^max\(/
    );
    assertDeclarations(css, '.pocket-mode.has-selected-word.pocket-word-panel-open #reader-view.active .reader-sidebar-wrapper[data-pocket-sheet-state="expanded"]', { top: "calc(var(--pocket-statusbar-safe-top) + 0.5rem)" });
    assertDeclarations(css, '.pocket-mode.has-selected-word.pocket-word-panel-open #reader-view.active .reader-sidebar-wrapper[data-pocket-sheet-state="custom"]', { top: "var(--pocket-word-sheet-top)" });
    assertDeclarations(css, ".pocket-mode .pocket-word-panel-sheet-handle", { display: "flex", "min-height": "56px", "touch-action": "none" });
    assertDeclarations(css, ".pocket-mode .word-panel.word-panel-card-ghost", { top: "56px" });
    assert.match(
      declarationBlock(css, ".pocket-mode.has-selected-word.pocket-word-panel-open #reader-view.active .reader-text")["padding-bottom"],
      /var\(--pocket-word-sheet-collapsed-size\)/
    );
    assertDeclarations(css, ".pocket-mode .word-panel", { flex: "1 1 auto", "min-height": "0", height: "auto", "max-height": "none", "overflow-y": "auto", background: "var(--word-panel-status-bg, var(--panel))", "touch-action": "pan-y pinch-zoom" });
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\)[\s\S]*pocket-word-sheet-dragging[\s\S]*transition: top 200ms/);
    assertDeclarations(css, ".pocket-mode .word-panel-header", { position: "sticky" });
    assertDeclarations(css, ".pocket-mode .word-panel-close", { display: "inline-flex" });
    assert.equal(css.includes("pocket-word-dictionary"), false);
    assertDeclarations(css, ".pocket-mode #word-panel .word-actions .secondary-button", { flex: "1 1 44px", "min-width": "44px" });
    assertDeclarations(sharedCss, ".sm2-grades .status-button.sm2-grade-1", { background: "var(--red-soft)" });
    assertDeclarations(sharedCss, ".sm2-grades .status-button.sm2-grade-3", { background: "var(--amber-soft)" });
    assertDeclarations(sharedCss, ".sm2-grades .status-button.sm2-grade-5", { background: "var(--green-soft)" });
    assertDeclarations(sharedCss, ".sm2-grades .status-button.sm2-grade-5", { color: "var(--green)" });
    assertDeclarations(sharedCss, ".word-panel.word-panel-card-dragging", { transition: "none !important" });
  });
});
