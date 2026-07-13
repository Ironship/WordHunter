import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const meta = { content: "", setAttribute(_name, value) { this.content = value; } };
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.document = {
  documentElement: { dataset: {} },
  querySelector: (selector) => selector === 'meta[name="theme-color"]' ? meta : null
};

const {
  DEFAULT_THEME,
  applyTheme,
  nextTheme,
  normalizeTheme,
  resolveTheme
} = await import("../../src/web/js/theme.js");
const { loadState, normalizeState } = await import("../../src/web/js/state/normalize.js");
const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
const { STATE_SCHEMA_VERSION } = await import("../../src/web/js/constants.js");
const { themeIcon } = await import("../../src/web/js/icons.js");

function themeBlock(styles, selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  return styles.slice(start, styles.indexOf("}", start));
}

function token(block, name) {
  return block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("named themes", () => {
  it("uses Familiar theme by default and migrates legacy preferences", () => {
    assert.equal(DEFAULT_THEME, "familiar");
    assert.equal(normalizeTheme(undefined), "familiar");
    assert.equal(normalizeTheme("unknown"), "familiar");
    assert.equal(normalizeTheme("auto"), "classic-auto");
    assert.equal(normalizeTheme("light"), "classic-light");
    assert.equal(normalizeTheme("dark"), "classic-dark");
    assert.equal(normalizeTheme(undefined, true), "classic-dark");
    assert.equal(normalizeTheme(undefined, false), "classic-light");
  });

  it("keeps automatic theme families responsive to the operating system", () => {
    assert.equal(resolveTheme("familiar", false).mode, "light");
    assert.equal(resolveTheme("familiar", true).mode, "dark");
    assert.equal(resolveTheme("alternative-familiar", false).mode, "light");
    assert.equal(resolveTheme("alternative-familiar", true).mode, "dark");
    assert.equal(resolveTheme("classic-auto", false).mode, "light");
    assert.equal(resolveTheme("classic-auto", true).mode, "dark");
    assert.equal(resolveTheme("classic-light", true).mode, "light");
    assert.equal(resolveTheme("classic-dark", false).mode, "dark");
  });

  it("cycles the quick action through every selectable theme", () => {
    assert.equal(nextTheme("familiar"), "alternative-familiar");
    assert.equal(nextTheme("alternative-familiar"), "classic-auto");
    assert.equal(nextTheme("classic-auto"), "classic-light");
    assert.equal(nextTheme("classic-light"), "classic-dark");
    assert.equal(nextTheme("classic-dark"), "familiar");
  });

  it("uses a distinct SVG for every theme quick action", () => {
    const icons = ["familiar", "alternative-familiar", "classic-auto", "classic-light", "classic-dark"].map(themeIcon);
    for (const svg of icons) {
      assert.match(svg, /^<svg/);
      assert.match(svg, /theme-toggle-icon/);
    }
    assert.equal(new Set(icons).size, icons.length);
  });

  it("applies palette, mode, preference and browser chrome color together", () => {
    const root = { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } };
    const resolved = applyTheme("alternative-familiar", root, false);

    assert.deepEqual(root.dataset, {
      theme: "light",
      themePref: "alternative-familiar",
      colorTheme: "alternative-familiar"
    });
    assert.equal(resolved.color, "#5e2750");
    assert.equal(meta.content, "#5e2750");
    assert.equal(root.style["--boot-bg"], "#5e2750");
    assert.equal(root.style.background, "#5e2750");
    assert.equal(root.style.colorScheme, "light");
  });

  it("uses named dark browser chrome colors", () => {
    assert.equal(resolveTheme("familiar", true).color, "#00395d");
    assert.equal(resolveTheme("alternative-familiar", true).color, "#2c001e");
    assert.equal(resolveTheme("classic-light", true).color, "#f7f9f6");
  });

  it("migrates the legacy darkMode preference through full state normalization", () => {
    assert.equal(normalizeState({ preferences: { darkMode: true } }).preferences.theme, "classic-dark");
    assert.equal(normalizeState({ preferences: { darkMode: false } }).preferences.theme, "classic-light");
  });

  it("migrates the legacy darkMode preference from a bridge snapshot before adding defaults", () => {
    window.__qtBridge = true;
    window.__bridgeState = { schemaVersion: STATE_SCHEMA_VERSION, prefs: { darkMode: false }, vocab: {} };
    try {
      assert.equal(loadState().preferences.theme, "classic-light");
      window.__bridgeState.prefs.darkMode = true;
      assert.equal(loadState().preferences.theme, "classic-dark");
    } finally {
      delete window.__qtBridge;
      delete window.__bridgeState;
    }
  });

  it("keeps theme global instead of restoring a per-language value", () => {
    const normalized = normalizeState({
      preferences: { learningLanguage: "de", theme: "dark" },
      profiles: {
        de: { preferences: {} },
        pl: { preferences: { theme: "alternative-familiar" } }
      }
    });
    assert.equal(normalized.preferences.theme, "classic-dark");
    const polish = normalizeState({
      preferences: { learningLanguage: "pl", theme: "light" },
      profiles: { pl: { preferences: { theme: "alternative-familiar" } } }
    });
    assert.equal(polish.preferences.theme, "classic-light");
    assert.equal(Object.hasOwn(createDefaultState().profiles.de.preferences, "theme"), false);
    assert.equal(Object.hasOwn(normalized.profiles.pl.preferences, "theme"), false);
  });

  it("defines complete, contrasting light and dark named palettes", () => {
    const styles = readFileSync(new URL("../../src/web/theme.css", import.meta.url), "utf8");
    const selectors = [
      ':root[data-color-theme="familiar"]',
      ':root[data-color-theme="alternative-familiar"]',
      ':root[data-color-theme="familiar"][data-theme="dark"]',
      ':root[data-color-theme="alternative-familiar"][data-theme="dark"]'
    ];
    for (const selector of selectors) {
      const block = themeBlock(styles, selector);
      for (const name of ["--bg", "--panel", "--ink", "--muted", "--line", "--green", "--green-soft", "--focus-ring", "--boot-bg", "--control-accent", "--control-accent-soft", "--control-accent-ink"]) {
        assert.ok(token(block, name), `${selector} is missing ${name}`);
      }
      assert.ok(contrast(token(block, "--ink"), token(block, "--bg")) >= 4.5, `${selector} background contrast`);
      assert.ok(contrast(token(block, "--ink"), token(block, "--panel")) >= 4.5, `${selector} panel contrast`);
      assert.ok(contrast(token(block, "--green"), token(block, "--green-soft")) >= 4.5, `${selector} status contrast`);
      assert.ok(contrast(token(block, "--focus-ring"), token(block, "--bg")) >= 3, `${selector} focus contrast`);
      assert.ok(contrast(token(block, "--control-accent"), token(block, "--control-accent-ink")) >= 4.5, `${selector} primary button contrast`);
    }
  });

  it("wires the Settings selector to all themes and themed control colors", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    assert.match(html, /<link rel="stylesheet" href="theme\.css[^>]*>/);
    assert.match(html, /<link rel="stylesheet" href="styles\.css[^>]*>/);
    assert.match(html, /<link rel="stylesheet" href="platforms\/android-pocket\.css[^>]*>/);
    assert.ok(html.indexOf("theme.css") < html.indexOf("styles.css"));
    assert.ok(html.indexOf("styles.css") < html.indexOf("platforms/android-pocket.css"));
    assert.match(html, /id="pref-theme" data-pref="theme"/);
    for (const theme of ["familiar", "alternative-familiar", "classic-auto", "classic-light", "classic-dark"]) {
      assert.match(html, new RegExp(`option value="${theme}"`));
    }
    assert.match(styles, /\.primary-button\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.match(styles, /input\[type="checkbox"\]:checked\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.match(styles, /#reader-highlight-toggle\[aria-pressed="true"\][^}]*border-color:\s*var\(--control-accent\)/s);
    assert.match(styles, /\.reader-zoom-slider input\[type="range"\]::-(?:webkit-slider-thumb|moz-range-thumb)\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.doesNotMatch(styles, /\.primary-button\s*\{[^}]*(?:background|border-color):\s*var\(--green\)/s);
    assert.match(html, /id="theme-toggle"[^>]*>[\s\S]*?<svg class="theme-toggle-icon"/);
    assert.doesNotMatch(html, /var\(--(?:text-color-muted|gray-soft)\)/);
  });

  it("keeps theme-sensitive component overrides visible and palette-driven", () => {
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const pocket = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const charts = readFileSync(new URL("../../src/web/js/graphs/charts.js", import.meta.url), "utf8");
    const helpers = readFileSync(new URL("../../src/web/js/graphs/helpers.js", import.meta.url), "utf8");
    assert.match(styles, /\.nav-item\.active:not\(\.nav-item-locked\)[^}]*var\(--sidebar-active-accent\)/s);
    assert.match(styles, /\.book-card\.archived\s*\{[^}]*border-style:\s*dashed/s);
    assert.doesNotMatch(themeBlock(styles, ".book-card.archived"), /opacity/);
    assert.match(pocket, /#reader-highlight-toggle\[aria-pressed="true"\][^}]*background:\s*var\(--sidebar-nav-active\)/s);
    assert.match(helpers, /labelMuted\s*=\s*muted/);
    assert.doesNotMatch(charts, /rgba\(79,\s*179,\s*142/);
    assert.doesNotMatch(charts, /rgba\(255,\s*255,\s*255,\s*0\.6\)/);
  });

  it("propagates named themes to the offline translator with contrasting button ink", () => {
    const sharedEvents = readFileSync(new URL("../../src/web/js/events/shared.js", import.meta.url), "utf8");
    const popup = readFileSync(new URL("../../src/web/templates/translator-popup.html", import.meta.url), "utf8");
    assert.match(sharedEvents, /family=\$\{theme\.family\}/);
    assert.match(popup, /data-color-theme="\{\{color_theme\}\}"/);
    assert.match(popup, /<link rel="stylesheet" href="\/theme\.css[^>]*>/);
    assert.ok(popup.indexOf("/theme.css") < popup.indexOf("<style>"));
    assert.doesNotMatch(popup, /--(?:bg|panel|panel-strong|ink|muted|line|shadow):\s*#/);
    assert.match(popup, /--popup-accent:\s*#297a5b/);
    assert.match(popup, /dataset\.theme\s*!==\s*"auto"/);
    assert.match(popup, /media\.addListener\(apply\)/);
    assert.match(popup, /\.primary-button[^}]*color:\s*var\(--popup-accent-ink\)/s);
    assert.match(popup, /box-shadow:[^;]*rgba\([^;]+;\s*box-shadow:[^;]*color-mix/s);
    assert.doesNotMatch(popup, /\.engine-info[^}]*opacity:/s);
  });
});
