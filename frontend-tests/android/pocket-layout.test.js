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

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function openingTagById(html, id) {
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    if (attributes.id === id) return { source: match[0], index: match.index, tagName: match[1].toLowerCase(), attributes };
  }
  assert.fail(`Missing element #${id}`);
}

function ancestorOpeningTag(html, id, tagName) {
  const target = openingTagById(html, id);
  const stack = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const match of html.matchAll(/<(\/)?([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (match.index >= target.index) break;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.map((entry) => entry.tagName).lastIndexOf(name);
      if (index !== -1) stack.length = index;
    } else if (!voidTags.has(name) && !match[0].endsWith("/>")) {
      stack.push({ source: match[0], tagName: name, attributes: tagAttributes(match[0]) });
    }
  }
  const ancestor = [...stack].reverse().find((entry) => entry.tagName === tagName);
  assert.ok(ancestor, `Missing ${tagName} ancestor for #${id}`);
  return ancestor;
}

function classTokens(element) {
  return new Set((element.attributes.class || "").split(/\s+/).filter(Boolean));
}

function relativeLuminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `Expected a six-digit hex color, received ${hex}`);
  const channels = hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function assertTextContrast(label, foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  assert.ok(ratio >= 4.5, `${label} contrast ${ratio.toFixed(2)} is below 4.5:1`);
}

describe("Android Pocket layout", () => {
  it("defines touch-sized Pocket vocabulary card declarations", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const sharedCss = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const vocabList = readFileSync(new URL("../../src/web/js/vocabulary/vocab-list.js", import.meta.url), "utf8");

    assertDeclarations(css, ".pocket-mode .table-wrap", { overflow: "visible" });
    assertDeclarations(css, ".pocket-mode .vocab-table", { "min-width": "0" });
    assertDeclarations(css, ".pocket-mode .vocab-table tbody", { display: "grid" });
    assertDeclarations(css, ".pocket-mode .vocab-table tr", { "grid-template-columns": "minmax(0, 1fr) auto" });
    assertDeclarations(css, ".pocket-mode .vocab-table td:last-child .row-actions", { "grid-template-columns": "repeat(4, 44px)" });
    assertDeclarations(css, ".pocket-mode .vocab-table td:last-child .row-actions .icon-button", { "max-width": "44px", "border-radius": "8px" });
    assertDeclarations(css, ".pocket-mode #vocabulary-view .panel-header > div:first-child", { display: "none" });
    assertDeclarations(css, ".pocket-mode #vocabulary-view .vocab-export-actions", { "grid-template-columns": "minmax(0, 1fr) 44px 44px" });
    assertDeclarations(css, ".pocket-mode .status-check", { "min-height": "44px" });
    assertDeclarations(css, ".pocket-mode textarea.vocab-translation-input", { resize: "none" });
    assertDeclarations(sharedCss, "textarea.vocab-translation-input", { "overflow-wrap": "anywhere" });
    assert.match(vocabList, /const pocketMode = document\.documentElement\.classList\.contains\("pocket-mode"\)/);
    assert.notEqual(vocabList.indexOf("pocketMode ? `"), -1);
    assert.notEqual(vocabList.indexOf("<textarea", vocabList.indexOf("pocketMode ? `")), -1);
  });

  it("defines start-aligned Pocket heatmap declarations", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, ".pocket-mode .graphs-heatmap", { "justify-content": "flex-start" });
    assertDeclarations(css, ".pocket-mode .review-heatmap", { "justify-content": "flex-start" });
  });

  it("defines closed and open Pocket import drawer states", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, ".pocket-mode .view.active", { animation: "none !important" });
    assertDeclarations(css, ".pocket-mode .import-panel", { "z-index": "80", visibility: "hidden", "pointer-events": "none" });
    assertDeclarations(css, ".pocket-mode.pocket-import-open .import-panel", { visibility: "visible", "pointer-events": "auto" });
    assertDeclarations(css, ".pocket-mode.pocket-import-open body::after", { "z-index": "75" });
    assertDeclarations(css, ".pocket-mode .pocket-import-toggle", { position: "fixed", right: "0" });
    assert.match(declarationBlock(css, ".pocket-mode .pocket-import-toggle::before").mask, /M15%2018l-6-6%206-6/);
    assertDeclarations(css, '.pocket-mode[data-view="library"] .pocket-import-toggle', { display: "inline-flex" });
    assertDeclarations(css, ".pocket-mode .pocket-drawer-close", { display: "inline-flex" });
  });

  it("marks library filters for the Pocket collapse control", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const library = readFileSync(new URL("../../src/web/js/views/library.js", import.meta.url), "utf8");
    const toggle = openingTagById(html, "library-filters-toggle");
    const filters = openingTagById(html, "library-filters");
    const panel = ancestorOpeningTag(html, "library-filters-toggle", "section");

    assert.ok(classTokens(panel).has("library-filters-collapsed"));
    assert.equal(toggle.attributes["aria-controls"], "library-filters");
    assert.ok(classTokens(filters).has("compact-filters"));
    assertDeclarations(css, ".pocket-mode .library-filters-toggle", { display: "inline-flex" });
    assertDeclarations(css, ".pocket-mode .library-panel.library-filters-collapsed .compact-filters", { display: "none" });
    assert.match(library, /classList\.toggle\("library-filters-collapsed", !expanded\)/);
    assert.match(library, /setAttribute\("aria-expanded", String\(expanded\)\)/);
  });

  it("defines the hidden and open Pocket navigation drawer", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, ".pocket-mode .sidebar", { "z-index": "80", visibility: "hidden", "pointer-events": "none" });
    assertDeclarations(css, ".pocket-mode.pocket-navigation-open .sidebar", { visibility: "visible", "pointer-events": "auto" });
    assertDeclarations(css, ".pocket-mode .pocket-navigation-toggle", { position: "fixed", display: "inline-flex", bottom: "calc(0.35rem + var(--pocket-navbar-safe-bottom))", background: "var(--sidebar-bg)" });
    assertDeclarations(css, '.pocket-mode[data-view="reader"] #pocket-navigation-toggle', { display: "none" });
    assert.equal(css.includes('.pocket-mode:not([data-view="reader"]) .topbar'), false);
    assertDeclarations(css, ".pocket-mode .nav-list", { "grid-template-columns": "minmax(0, 1fr)", "align-items": "stretch" });
    assertDeclarations(css, ".pocket-mode .nav-item", { "grid-template-columns": "30px minmax(0, 1fr)", "max-width": "100%", overflow: "hidden" });
    assertDeclarations(css, ".pocket-mode .nav-item > span:not(.nav-icon):not(.shortcut-badge)", { "overflow-wrap": "anywhere" });
  });

  it("defines finger-sized Pocket flashcard and toggle controls", () => {
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, ".pocket-mode #flashcards-view .word-actions", { "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
    assertDeclarations(css, ".pocket-mode #flashcards-view .word-actions .secondary-button", { "min-height": "44px" });
    assertDeclarations(css, ".pocket-mode #flashcards-view [data-tts-word].secondary-button", { width: "44px !important", flex: "0 0 44px !important" });
    assertDeclarations(css, '.pocket-mode .setting-row input[type="checkbox"]', { width: "68px", height: "40px" });
  });

  it("meets WCAG AA contrast for common Pocket theme text pairs", () => {
    const css = readFileSync(new URL("../../src/web/theme.css", import.meta.url), "utf8");
    const light = declarationBlock(css, ":root");
    const dark = declarationBlock(css, ':root[data-theme="dark"]');

    assertTextContrast("light muted text", light["--muted"], light["--bg"]);
    assertTextContrast("light known status", light["--green"], light["--green-soft"]);
    assertTextContrast("light new status", light["--amber"], light["--amber-soft"]);
    assertTextContrast("dark primary button", dark["--control-accent-ink"], dark["--control-accent"]);
    assertTextContrast("dark secondary button", dark["--ink"], dark["--panel"]);
    assertTextContrast("dark known status", dark["--green"], dark["--green-soft"]);
  });

  it("defines circular settings color-picker declarations", () => {
    const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const pocketCss = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");

    assertDeclarations(css, ".color-picker-lg", { "aspect-ratio": "1", overflow: "hidden" });
    assertDeclarations(css, ".color-picker-lg::-webkit-color-swatch-wrapper", { padding: "0" });
    assertDeclarations(css, ".color-picker-lg::-webkit-color-swatch", { width: "100%", height: "100%" });
    assertDeclarations(pocketCss, ".pocket-mode input.color-picker-lg", { "min-height": "var(--color-picker-size)" });
  });
});
