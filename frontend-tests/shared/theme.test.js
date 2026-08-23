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
} = await import("../../dist/web/js/theme.js");
const { loadState, normalizeState } = await import("../../dist/web/js/state/normalize.js");
const { createDefaultState } = await import("../../dist/web/js/state/defaults.js");
const { STATE_SCHEMA_VERSION } = await import("../../dist/web/js/constants.js");
const { themeIcon } = await import("../../dist/web/js/icons.js");

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

  it("keeps Familiar themes dark on desktop while Pocket follows the system", () => {
    const root = { dataset: { platform: "desktop" }, style: { setProperty(name, value) { this[name] = value; } } };
    assert.equal(applyTheme("familiar", root, false).mode, "dark");
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.style.colorScheme, "dark");
    assert.equal(meta.content, "#00395d");

    root.dataset.platform = "android";
    assert.equal(applyTheme("alternative-familiar", root, false).mode, "light");
    assert.equal(root.dataset.theme, "light");
    assert.equal(meta.content, "#5e2750");
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
    const styles = readFileSync(new URL("../../dist/web/theme.css", import.meta.url), "utf8");
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
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    // settings folder module (behaviour) + settings-view-template.js
    // (markup, split 93a1828).
    const SETTINGS_FOLDER_FILES = [
      "index.js", "ai-models.js", "ai-preferences.js", "appearance.js", "data.js",
      "languages.js", "preference-controls.js", "renderers.js", "review.js",
      "shared.js", "translator.js"
    ];
    const settingsSource = [
      ...SETTINGS_FOLDER_FILES.map((file) => new URL(`../../dist/web/js/events/settings/${file}`, import.meta.url)),
      new URL("../../dist/web/js/events/settings-view-template.js", import.meta.url)
    ].map((url) => readFileSync(url, "utf8")).join("\n");
    const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    assert.match(html, /<link rel="stylesheet" href="theme\.css[^>]*>/);
    assert.match(html, /<link rel="stylesheet" href="styles\.css[^>]*>/);
    assert.match(html, /<link rel="stylesheet" href="platforms\/android-pocket\.css[^>]*>/);
    assert.ok(html.indexOf("theme.css") < html.indexOf("styles.css"));
    assert.ok(html.indexOf("styles.css") < html.indexOf("platforms/android-pocket.css"));
    // The Settings view is built at boot by renderSettingsView() (port of
    // #127 P3) — the theme selector lives in the renderer source.
    assert.match(settingsSource, /id="pref-theme" data-pref="theme"/);
    for (const theme of ["familiar", "alternative-familiar", "classic-auto", "classic-light", "classic-dark"]) {
      assert.match(settingsSource, new RegExp(`option value="${theme}"`));
    }
    assert.match(styles, /\.primary-button\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.match(styles, /input\[type="checkbox"\]:checked\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.match(styles, /#reader-highlight-toggle\[aria-pressed="true"\][^}]*border-color:\s*var\(--control-accent\)/s);
    assert.match(styles, /\.reader-zoom-slider input\[type="range"\]::-(?:webkit-slider-thumb|moz-range-thumb)\s*\{[^}]*background:\s*var\(--control-accent\)/s);
    assert.doesNotMatch(styles, /\.primary-button\s*\{[^}]*(?:background|border-color):\s*var\(--green\)/s);
    assert.match(html, /id="theme-toggle"[^>]*>[\s\S]*?<svg class="theme-toggle-icon"/);
    assert.doesNotMatch(html, /var\(--(?:text-color-muted|gray-soft)\)/);
  });

  it("keeps live layout selectors intact when dead CSS selectors are removed", () => {
    const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const pocketStyles = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");
    assert.match(styles, /\.topbar h1,\s*\.panel h2\s*\{[^}]*margin:\s*0;[^}]*line-height:\s*1\.2/s);
    assert.match(styles, /\.workspace-grid,\s*\.reader-grid,\s*\.settings-grid\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1rem/s);
    assert.match(styles, /#settings-view\.active > \.settings-grid\s*\{[^}]*min-height:\s*0/s);
    assert.match(styles, /\.table-wrap\s*\{[^}]*min-height:\s*0/s);
    assert.doesNotMatch(styles, /#settings-view\.active > \.settings-grid,\s*\.table-wrap/);
    assert.match(styles, /\.book-meta\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*0\.4rem/s);
    assert.match(styles, /\.book-actions\s*\{[^}]*display:\s*flex;[^}]*margin-top:\s*auto/s);
    assert.doesNotMatch(styles, /\.book-actions,\s*\.primary-button/);
    for (const deadClass of [
      "brand-mark", "danger-link", "footer-action", "form-actions", "help-grid", "help-list",
      "review-forecast", "settings-actions", "tag-row", "toolbar-actions", "user-book-row"
    ]) {
      const selector = new RegExp(`\\.${deadClass}(?![\\w-])`);
      assert.doesNotMatch(styles, selector);
      assert.doesNotMatch(pocketStyles, selector);
    }
  });

  it("keeps the audited CSS scalable and limits important to real cascade boundaries", () => {
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const pocketStyles = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const themeStyles = readFileSync(new URL("../../src/web/theme.css", import.meta.url), "utf8");

    assert.doesNotMatch(styles, /(?:font-size|--reader-font-size):\s*[0-9.]+px/);
    assert.match(themeStyles, /--ink-inversed:\s*#(?:fff|ffffff);/i);
    assert.match(styles, /\.toast-close:hover\s*\{[^}]*color:\s*var\(--ink-inversed\)/s);
    assert.doesNotMatch(styles, /\.word-token\.tts-current-word\s*\{[^}]*!important/s);
    assert.doesNotMatch(styles, /:root\.no-token-highlight \.word-token\s*\{[^}]*!important/s);
    assert.doesNotMatch(pocketStyles, /\.pocket-mode \.vocab-table td\s*\{[^}]*!important/s);
    assert.ok((styles.match(/!important/g) ?? []).length <= 62);
    assert.ok((pocketStyles.match(/!important/g) ?? []).length <= 9);
  });

  it("uses distinct themed surfaces for light desktop layouts", () => {
    const themeStyles = readFileSync(new URL("../../dist/web/theme.css", import.meta.url), "utf8");
    const componentStyles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const backgrounds = [];
    const panels = [];
    for (const selector of [':root', ':root[data-color-theme="familiar"]', ':root[data-color-theme="alternative-familiar"]']) {
      const block = themeBlock(themeStyles, selector);
      const background = token(block, "--desktop-bg");
      const panel = token(block, "--desktop-panel");
      const ink = token(block, "--ink");
      backgrounds.push(background);
      panels.push(panel);
      assert.notEqual(background, "#ffffff", `${selector} desktop background must be themed`);
      assert.notEqual(panel, "#ffffff", `${selector} desktop panel must be themed`);
      assert.ok(contrast(ink, background) >= 4.5, `${selector} desktop background contrast`);
      assert.ok(contrast(ink, panel) >= 4.5, `${selector} desktop panel contrast`);
    }
    assert.equal(new Set(backgrounds).size, backgrounds.length, "desktop theme backgrounds must differ");
    assert.equal(new Set(panels).size, panels.length, "desktop theme panels must differ");
    const desktop = themeBlock(componentStyles, ':root:not(.pocket-mode)[data-theme="light"]');
    assert.match(desktop, /--bg:\s*var\(--desktop-bg\)/);
    assert.match(desktop, /--panel:\s*var\(--desktop-panel\)/);
  });

  it("keeps theme-sensitive component overrides visible and palette-driven", () => {
    const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const pocket = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const charts = readFileSync(new URL("../../dist/web/js/graphs/charts.js", import.meta.url), "utf8");
    const helpers = readFileSync(new URL("../../dist/web/js/graphs/helpers.js", import.meta.url), "utf8");
    assert.match(styles, /\.nav-item\.active:not\(\.nav-item-locked\)[^}]*var\(--sidebar-active-accent\)/s);
    assert.match(styles, /\.book-card\.archived\s*\{[^}]*border-style:\s*dashed/s);
    assert.doesNotMatch(themeBlock(styles, ".book-card.archived"), /opacity/);
    assert.match(pocket, /#reader-highlight-toggle\[aria-pressed="true"\][^}]*background:\s*var\(--sidebar-nav-active\)/s);
    assert.match(helpers, /labelMuted\s*=\s*muted/);
    assert.doesNotMatch(charts, /rgba\(79,\s*179,\s*142/);
    assert.doesNotMatch(charts, /rgba\(255,\s*255,\s*255,\s*0\.6\)/);
  });

  it("propagates named themes to the offline translator with contrasting button ink", () => {
    const sharedEvents = readFileSync(new URL("../../dist/web/js/events/shared.js", import.meta.url), "utf8");
    const youglish = readFileSync(new URL("../../dist/web/js/youglish.js", import.meta.url), "utf8");
    const popup = readFileSync(new URL("../../dist/web/templates/translator-popup.html", import.meta.url), "utf8");
    const popupRuntime = readFileSync(new URL("../../dist/web/translator-popup.js", import.meta.url), "utf8");
    assert.match(sharedEvents, /family=\$\{theme\.family\}/);
    assert.match(sharedEvents, /document\.documentElement\.dataset\.theme === "dark"/);
    assert.match(youglish, /youglishWidgetTheme === theme/);
    assert.match(youglish, /replaceChildren\(\)/);
    assert.match(youglish, /export function refreshYouGlishTheme/);
    assert.match(youglish, /youglishLastRequest = \{ word, language: ygLang \}/);
    assert.match(youglish, /youglishWidget\.fetch\(youglishLastRequest\.word, youglishLastRequest\.language\)/);
    assert.match(popup, /data-color-theme="\{\{color_theme\}\}"/);
    assert.match(popup, /<link rel="stylesheet" href="\/theme\.css[^>]*>/);
    assert.ok(popup.indexOf("/theme.css") < popup.indexOf("<style>"));
    assert.doesNotMatch(popup, /--(?:bg|panel|panel-strong|ink|muted|line|shadow):\s*#/);
    assert.match(popup, /--popup-accent:\s*#297a5b/);
    assert.match(popup, /<script type="module" src="\/translator-popup\.js\?v=[0-9a-f]{12}"><\/script>/);
    assert.match(popupRuntime, /dataset\.theme\s*!==\s*"auto"/);
    assert.match(popupRuntime, /media\.addListener\(apply\)/);
    assert.match(popup, /\.primary-button[^}]*color:\s*var\(--popup-accent-ink\)/s);
    assert.match(popup, /box-shadow:[^;]*rgba\([^;]+;\s*box-shadow:[^;]*color-mix/s);
    assert.doesNotMatch(popup, /\.engine-info[^}]*opacity:/s);
  });
});

describe("boot-bg token parity (theme.ts ↔ theme.css)", () => {
  /* P3 #129 token-drift guard: applyTheme() sets --boot-bg at runtime from
     resolveTheme() colors (theme.ts); the static stylesheet declares the same
     token for the pre-JS boot paint (theme.css). If the two drift apart, the
     boot flash color no longer matches the first themed paint.
     Baseline (2026-08): 6/6 parity — familiar #0067a8/#00395d,
     alternative-familiar #5e2750/#2c001e, classic #f7f9f6/#0d1114. */
  const tsSource = readFileSync(new URL("../../src/web/js/theme.ts", import.meta.url), "utf8");
  const cssSource = readFileSync(new URL("../../src/web/theme.css", import.meta.url), "utf8");

  const tsBootColors = () =>
    [...tsSource.matchAll(/"#[0-9a-fA-F]{6}"/g)]
      .map((m) => m[0].slice(2, -1).toLowerCase()).sort();
  const cssBootBg = () =>
    [...cssSource.matchAll(/--boot-bg:\s*#[0-9a-fA-F]{6}/g)]
      .map((m) => m[0].match(/#[0-9a-fA-F]{6}/)[0].slice(1).toLowerCase()).sort();

  it("pins the 6 theme.ts boot colors", () => {
    assert.deepEqual(tsBootColors(),
      ["00395d", "0067a8", "0d1114", "2c001e", "5e2750", "f7f9f6"],
      "theme.ts resolveTheme() must keep exactly the 6 pinned boot colors");
  });

  it("pins the 6 theme.css --boot-bg values", () => {
    assert.deepEqual(cssBootBg(),
      ["00395d", "0067a8", "0d1114", "2c001e", "5e2750", "f7f9f6"],
      "theme.css must keep exactly the 6 pinned --boot-bg values");
  });

  it("keeps theme.ts boot colors in parity with theme.css --boot-bg", () => {
    assert.deepEqual(tsBootColors(), cssBootBg(),
      "theme.ts resolveTheme() colors and theme.css --boot-bg must stay identical " +
      "(runtime theme color vs pre-JS boot paint)");
  });
});
