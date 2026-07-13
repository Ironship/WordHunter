import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
const css = ["theme.css", "styles.css"]
  .map((file) => readFileSync(new URL(`../../dist/web/${file}`, import.meta.url), "utf8"))
  .join("\n");
const pocketCss = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");
const desktopWindow = readFileSync(new URL("../../src-tauri/src/platform/web_app.rs", import.meta.url), "utf8");
const cargoToml = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const flatpakDesktop = readFileSync(new URL("../../flatpak/com.wordhunter.app.desktop", import.meta.url), "utf8");
const flatpakMeta = readFileSync(new URL("../../flatpak/com.wordhunter.app.metainfo.xml", import.meta.url), "utf8");
const flatpakManifest = readFileSync(new URL("../../com.wordhunter.app.yml", import.meta.url), "utf8");

function attribute(openingTag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = openingTag.match(new RegExp(`\\s${escaped}(?:="([^"]*)")?(?=\\s|/?>)`, "i"));
  return match ? (match[1] ?? "") : null;
}

function openingTag(element) {
  return element.match(/^<[^>]+>/)?.[0] || "";
}

function extractElementAt(source, match) {
  const tag = match[1].toLowerCase();
  if (["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tag)) {
    return match[0];
  }
  const tokenPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tokenPattern.lastIndex = match.index;
  let depth = 0;
  for (const token of source.matchAll(tokenPattern)) {
    if (token[0].startsWith("</")) depth -= 1;
    else if (!token[0].endsWith("/>")) depth += 1;
    if (depth === 0) return source.slice(match.index, token.index + token[0].length);
  }
  assert.fail(`unclosed <${tag}> element`);
}

function findElement(source, predicate, tagName = "[a-z][\\w:-]*") {
  const pattern = new RegExp(`<(${tagName})\\b[^>]*>`, "gi");
  for (const match of source.matchAll(pattern)) {
    if (predicate(match[0])) return extractElementAt(source, match);
  }
  return null;
}

function elementByAttribute(source, name, value, tagName) {
  const element = findElement(source, (tag) => attribute(tag, name) === value, tagName);
  assert.ok(element, `<${tagName || "element"}> with ${name}="${value}" should exist`);
  return element;
}

function elementById(source, id) {
  return elementByAttribute(source, "id", id);
}

function elementByClass(source, className, tagName) {
  const element = findElement(source, (tag) => (attribute(tag, "class") || "").split(/\s+/).includes(className), tagName);
  assert.ok(element, `<${tagName || "element"}> with class ${className} should exist`);
  return element;
}

function containingElementById(source, tagName, id) {
  const targetPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  const target = [...source.matchAll(targetPattern)].find((match) => attribute(match[0], "id") === id);
  assert.ok(target, `element #${id} should exist`);
  const candidates = [];
  const pattern = new RegExp(`<(${tagName})\\b[^>]*>`, "gi");
  for (const match of source.matchAll(pattern)) {
    if (match.index > target.index) break;
    const element = extractElementAt(source, match);
    if (match.index + element.length >= target.index + target[0].length) candidates.push(element);
  }
  assert.ok(candidates.length, `<${tagName}> containing #${id} should exist`);
  return candidates.at(-1);
}

function hasClass(element, className) {
  return (attribute(openingTag(element), "class") || "").split(/\s+/).includes(className);
}

function cssRules(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
    const declarations = {};
    for (const declaration of match[2].matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+?)\s*(?=;|$)/g)) {
      declarations[declaration[1]] = declaration[2].trim();
    }
    return {
      selectors: match[1].split(",").map((selector) => selector.trim()),
      declarations
    };
  });
}

function cssDeclarations(source, selector) {
  const matches = cssRules(source).filter((rule) => rule.selectors.includes(selector));
  assert.ok(matches.length, `CSS selector ${selector} should exist`);
  return Object.assign({}, ...matches.map((rule) => rule.declarations));
}

function hasCssSelector(source, selector) {
  return cssRules(source).some((rule) => rule.selectors.includes(selector));
}

function tomlSection(source, heading) {
  const start = source.indexOf(`[${heading}]`);
  assert.ok(start >= 0, `TOML section [${heading}] should exist`);
  const next = source.indexOf("\n[", start + heading.length + 2);
  return source.slice(start, next < 0 ? source.length : next);
}

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    }
  };
}

function control(extra = {}) {
  const listeners = new Map();
  const attributes = {};
  return {
    checked: false,
    classList: fakeClassList(),
    dataset: {},
    disabled: false,
    hidden: false,
    id: "",
    innerHTML: "",
    style: {},
    textContent: "",
    value: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    listener(type) { return listeners.get(type); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    ...extra
  };
}

const documentListeners = new Map();
const rootStyle = {
  zoom: "1",
  values: new Map(),
  setProperty(name, value) { this.values.set(name, value); }
};
globalThis.window = {
  __qtBridge: false,
  location: { search: "" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false, addEventListener() {} }; },
  setTimeout,
  clearTimeout
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
class FakeElement {
  static [Symbol.hasInstance](value) {
    return value !== null && typeof value === "object";
  }
}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.HTMLInputElement = FakeElement;
globalThis.HTMLSelectElement = FakeElement;
globalThis.document = {
  activeElement: null,
  body: { classList: fakeClassList(), contains() { return false; } },
  documentElement: {
    dataset: { platform: "desktop" },
    style: rootStyle,
    classList: fakeClassList()
  },
  addEventListener(type, listener) {
    const listeners = documentListeners.get(type) || [];
    listeners.push(listener);
    documentListeners.set(type, listeners);
  },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
globalThis.requestAnimationFrame = (callback) => callback();

const { els } = await import("../../dist/web/js/dom.js");
const { createDefaultState, normalizeState, replaceState, state } = await import("../../dist/web/js/state.js");
const { applyPreferences, syncSettingsControls, updatePreferenceValue } = await import("../../dist/web/js/preferences.js");
const { bindGlobalActionEvents } = await import("../../dist/web/js/events/global-actions.js");
const { bindReaderEvents } = await import("../../dist/web/js/views/reader.js");
const {
  getPdfOcrViewMode,
  getPdfOcrZoom,
  setPdfOcrViewMode,
  setPdfOcrZoom
} = await import("../../dist/web/js/reader/pdf-ocr-renderer.js");

function setupPreferenceControls() {
  els.prefLocales = [];
  els.prefLearningLanguages = [];
  els.ankiExportStatusFilters = [];
  els.prefLearningColors = [];
  for (const key of ["prefFont", "prefLineHeight", "prefFontSize", "prefHighlight", "prefAutoLearn", "prefCardStats"]) {
    els[key] = control();
  }
  els.prefReaderFocusMode = control();
  els.prefReaderWordPanelVisible = control();
  els.prefTouchControls = control();
  els.prefTtsWordHighlight = control();
  els.readerHighlightToggle = control();
  els.readerWordPanelToggle = control();
}

function setupShellControls() {
  els.navItems = [];
  els.views = [];
  els.pageTitle = control();
  els.overallCount = control();
  els.pillKnown = control();
  els.pillLearning = control();
  els.pillNew = control();
}

function resetBehaviorState(extra = {}) {
  const defaults = createDefaultState();
  replaceState({
    ...defaults,
    ...extra,
    preferences: { ...defaults.preferences, ...(extra.preferences || {}) }
  }, { save: false });
  document.documentElement.dataset.platform = "desktop";
  document.documentElement.classList = fakeClassList();
  setupPreferenceControls();
  setupShellControls();
}

describe("desktop reader behavior", () => {
  it("normalizes persisted desktop reader preferences", () => {
    const defaults = createDefaultState().preferences;
    assert.equal(defaults.readerFocusMode, false);
    assert.equal(defaults.readerWordPanelVisible, true);
    assert.equal(defaults.touchControls, false);
    assert.equal(defaults.ttsWordHighlight, true);
    assert.equal(defaults.statusSoundsEnabled, true);

    const normalized = normalizeState({
      ...createDefaultState(),
      preferences: {
        readerFocusMode: "yes",
        readerWordPanelVisible: "no",
        touchControls: "true",
        ttsWordHighlight: "true"
      }
    }).preferences;
    assert.equal(normalized.readerFocusMode, false);
    assert.equal(normalized.readerWordPanelVisible, true);
    assert.equal(normalized.touchControls, false);
    assert.equal(normalized.ttsWordHighlight, true);
  });

  it("applies desktop preferences to classes and synchronized controls", () => {
    resetBehaviorState();

    updatePreferenceValue("readerFocusMode", true);
    updatePreferenceValue("readerWordPanelVisible", false);
    updatePreferenceValue("touchControls", true);
    updatePreferenceValue("ttsWordHighlight", true);
    syncSettingsControls();

    assert.equal(state.preferences.readerFocusMode, true);
    assert.equal(state.preferences.readerWordPanelVisible, false);
    assert.equal(state.preferences.touchControls, true);
    assert.equal(state.preferences.ttsWordHighlight, true);
    assert.equal(document.documentElement.classList.contains("reader-focus-mode"), true);
    assert.equal(document.documentElement.classList.contains("reader-word-panel-hidden"), true);
    assert.equal(document.documentElement.classList.contains("touch-controls-mode"), true);
    assert.equal(els.prefReaderFocusMode.checked, true);
    assert.equal(els.prefReaderWordPanelVisible.checked, false);
    assert.equal(els.prefTouchControls.checked, true);
    assert.equal(els.prefTtsWordHighlight.checked, true);

    document.documentElement.dataset.platform = "android";
    applyPreferences();
    assert.equal(document.documentElement.classList.contains("reader-focus-mode"), false);
    assert.equal(document.documentElement.classList.contains("reader-word-panel-hidden"), false);
    assert.equal(document.documentElement.classList.contains("touch-controls-mode"), false);
  });

  it("executes reader toolbar preference toggles", () => {
    resetBehaviorState();
    bindGlobalActionEvents();
    const click = documentListeners.get("click").at(-1);
    const eventFor = (id) => ({
      composedPath() { return []; },
      target: { closest(selector) { return selector === `#${id}` ? this : null; } }
    });

    click(eventFor("reader-highlight-toggle"));
    assert.equal(state.preferences.highlightTokens, false);
    assert.equal(document.documentElement.classList.contains("no-token-highlight"), true);
    assert.equal(els.readerHighlightToggle.getAttribute("aria-pressed"), "false");

    click(eventFor("reader-word-panel-toggle"));
    assert.equal(state.preferences.readerWordPanelVisible, false);
    assert.equal(document.documentElement.classList.contains("reader-word-panel-hidden"), true);
    assert.equal(els.readerWordPanelToggle.getAttribute("aria-pressed"), "false");
  });

  it("keeps reader selection while the word panel receives focus", async () => {
    resetBehaviorState({ currentView: "reader", selectedWord: "wort" });
    const readerText = control({ dataset: {}, querySelectorAll() { return []; } });
    const wordPanel = control();
    els.readerSidebarResizer = null;
    els.textSelect = control();
    els.readerText = readerText;
    els.wordPanel = wordPanel;

    bindReaderEvents();
    await new Promise((resolve) => setImmediate(resolve));

    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setTimeout = (callback) => { callback(); return 0; };
    document.activeElement = { closest() { return null; } };
    try {
      wordPanel.listener("pointerdown")();
      readerText.listener("focusout")();
      assert.equal(state.selectedWord, "wort");

      now = 2_000;
      readerText.listener("focusout")();
      assert.equal(state.selectedWord, null);
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe("desktop reader markup and style contracts", () => {
  it("declares desktop-only focus, panel, touch, and TTS controls", () => {
    for (const [id, preference] of [
      ["pref-reader-focus-mode", "readerFocusMode"],
      ["pref-reader-word-panel-visible", "readerWordPanelVisible"],
      ["pref-touch-controls", "touchControls"],
      ["pref-tts-word-highlight", "ttsWordHighlight"]
    ]) {
      const input = elementById(html, id);
      assert.equal(attribute(openingTag(input), "data-pref"), preference);
    }
    assert.equal(hasClass(containingElementById(html, "label", "pref-reader-focus-mode"), "desktop-only-setting"), true);
    assert.equal(hasClass(containingElementById(html, "label", "pref-reader-word-panel-visible"), "desktop-only-setting"), true);
    assert.equal(hasClass(containingElementById(html, "label", "pref-touch-controls"), "desktop-only-setting"), true);

    const panelToggle = elementById(html, "reader-word-panel-toggle");
    assert.equal(hasClass(panelToggle, "desktop-only-control"), true);
    assert.doesNotMatch(panelToggle, /<svg\b/);
    assert.match(panelToggle, /&gt;&gt;/);
    assert.equal(attribute(openingTag(elementById(html, "reader-highlight-toggle")), "aria-pressed"), "true");
  });

  it("scopes focus and word-panel layout rules to desktop reader state", () => {
    for (const selector of [
      ':root.reader-focus-mode:not(.pocket-mode)[data-view="reader"] .topbar',
      ':root.reader-focus-mode:not(.pocket-mode)[data-view="reader"] .reader-meta',
      ':root.reader-focus-mode:not(.pocket-mode)[data-view="reader"] .focus-hint'
    ]) {
      assert.equal(cssDeclarations(css, selector).display, "none");
    }
    assert.equal(
      cssDeclarations(css, ':root.reader-word-panel-hidden:not(.pocket-mode)[data-view="reader"] .reader-grid')["grid-template-columns"],
      "minmax(0, 1fr)"
    );
    assert.equal(
      cssDeclarations(css, ':root.reader-word-panel-hidden:not(.pocket-mode)[data-view="reader"] .reader-sidebar-resizer').display,
      "none"
    );
    assert.equal(
      cssDeclarations(css, ':root.reader-word-panel-hidden:not(.pocket-mode)[data-view="reader"] .reader-sidebar-wrapper').display,
      "none"
    );
    assert.equal(cssDeclarations(css, '#reader-highlight-toggle[aria-pressed="true"]')["border-color"], "var(--control-accent)");
    assert.equal(cssDeclarations(css, '#reader-word-panel-toggle[aria-pressed="true"]')["border-color"], "var(--control-accent)");
  });

  it("limits the larger-control option to selected desktop controls", () => {
    for (const selector of [
      ":root.touch-controls-mode:not(.pocket-mode) .primary-button",
      ":root.touch-controls-mode:not(.pocket-mode) .nav-item",
      ":root.touch-controls-mode:not(.pocket-mode) .status-check"
    ]) {
      assert.equal(cssDeclarations(css, selector)["min-height"], "44px !important");
    }
    for (const selector of [
      ":root.touch-controls-mode:not(.pocket-mode) .toast-close",
      ':root.touch-controls-mode:not(.pocket-mode) button[data-action="remove-image"]'
    ]) {
      assert.equal(cssDeclarations(css, selector).width, "44px !important");
      assert.equal(cssDeclarations(css, selector).height, "44px !important");
    }
    assert.equal(
      cssDeclarations(css, ':root.touch-controls-mode:not(.pocket-mode) .book-actions [data-action="read-sample"]')["min-width"],
      "max-content"
    );
    assert.equal(hasCssSelector(css, ":root.touch-controls-mode:not(.pocket-mode) button"), false);
  });

  it("keeps form-control colors explicit for WebKitGTK dark mode", () => {
    assert.equal(cssDeclarations(css, ":root")["color-scheme"], "light");
    assert.equal(cssDeclarations(css, ':root[data-theme="dark"]')["color-scheme"], "dark");
    for (const selector of ["input", "select", "textarea"]) {
      assert.equal(cssDeclarations(css, selector).background, "var(--panel)");
    }
    const select = cssDeclarations(css, "select");
    assert.equal(select["-webkit-appearance"], "none");
    assert.equal(select["background-image"], "var(--select-arrow)");
    assert.equal(cssDeclarations(css, "select option").background, "var(--panel)");
    assert.equal(cssDeclarations(css, "select optgroup").background, "var(--panel)");
  });

  it("declares desktop discovery, Help, and language navigation", () => {
    elementByAttribute(html, "data-view", "discover", "button");
    elementById(html, "discover-view");
    elementByAttribute(elementById(html, "discover-view"), "value", "gutenberg", "option");
    elementByAttribute(html, "data-view", "help", "button");
    elementById(html, "help-view");
    elementById(html, "pref-locale-sidebar");
    elementById(html, "pref-learning-language-sidebar");
    elementByAttribute(html, "data-language-flag", "locale", "img");
    elementByAttribute(html, "data-language-flag", "learning", "img");
  });

  it("keeps long navigation labels separate from shortcut badges", () => {
    const label = cssDeclarations(css, ".nav-item > span:not(.nav-icon):not(.shortcut-badge)");
    assert.equal(label["min-width"], "0");
    assert.equal(label["overflow-wrap"], "anywhere");
    const badge = cssDeclarations(css, ".nav-item > .shortcut-badge");
    assert.equal(badge["justify-self"], "end");
    assert.equal(badge["white-space"], "nowrap");
    assert.equal(badge["margin-left"], "0");
  });

  it("statically suppresses Pocket drawer controls outside Pocket mode", () => {
    assert.equal(hasClass(elementById(html, "library-import-toggle"), "pocket-import-toggle"), true);
    assert.equal(hasClass(elementById(html, "library-import-close"), "pocket-drawer-close"), true);
    assert.equal(hasClass(elementById(html, "pocket-navigation-toggle"), "pocket-navigation-toggle"), true);
    assert.equal(hasClass(elementById(html, "reader-pocket-navigation-toggle"), "pocket-reader-navigation-toggle"), true);
    assert.equal(cssDeclarations(css, ":root:not(.pocket-mode) button.pocket-import-toggle").display, "none");
    assert.equal(cssDeclarations(css, ":root:not(.pocket-mode) button.pocket-drawer-close").display, "none");
    assert.equal(cssDeclarations(css, ":root:not(.pocket-mode) button.pocket-navigation-toggle").display, "none");
    assert.equal(cssDeclarations(css, ":root:not(.pocket-mode) button.pocket-reader-navigation-toggle").display, "none");
  });

  it("defines a compact desktop library-filter layout", () => {
    const header = cssDeclarations(css, ".library-panel > .panel-header");
    assert.equal(header.display, "flex");
    assert.equal(header["align-items"], "flex-end");
    assert.equal(header["flex-wrap"], "nowrap");
    assert.equal(cssDeclarations(css, "button.library-filters-toggle").display, "none");
    const filters = cssDeclarations(css, ".library-panel .compact-filters");
    assert.equal(filters["flex-wrap"], "nowrap");
    assert.equal(filters["align-items"], "flex-end");
    assert.equal(filters["min-width"], "0");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .library-filters-toggle").display, "inline-flex");
  });

  it("keeps Settings and Sync as separate structural sections", () => {
    const settingsSection = elementById(html, "settings-view");
    const syncSection = elementById(html, "sync-view");
    for (const key of ["groupLanguage", "groupLearningDisplay", "groupReader", "groupTts", "groupLocalData", "groupBackup"]) {
      elementByAttribute(settingsSection, "data-i18n", `settings.${key}`);
    }
    assert.equal(findElement(settingsSection, (tag) => attribute(tag, "id") === "sync-directory"), null);
    assert.equal(findElement(settingsSection, (tag) => attribute(tag, "id") === "syncthing-setup-wizard"), null);
    assert.equal(attribute(openingTag(syncSection), "data-title-key"), "nav.sync");
    elementByAttribute(syncSection, "data-i18n", "settings.groupSync");
    assert.equal(cssDeclarations(css, ".settings-subheading")["text-transform"], "uppercase");
  });

  it("defines a scrollable edit-book dialog layout", () => {
    const dialog = elementById(html, "edit-book-dialog");
    assert.equal(hasClass(dialog, "edit-book-dialog"), true);
    elementByClass(dialog, "edit-book-body", "div");
    elementById(dialog, "edit-book-save");
    assert.equal(hasClass(elementById(dialog, "edit-book-cover-clear"), "edit-book-cover-clear"), true);
    assert.deepEqual(
      { display: cssDeclarations(css, ".edit-book-dialog[open]").display, direction: cssDeclarations(css, ".edit-book-dialog[open]")["flex-direction"] },
      { display: "flex", direction: "column" }
    );
    assert.equal(cssDeclarations(css, ".edit-book-body")["overflow-y"], "auto");
    const fields = cssDeclarations(css, ".edit-book-body .edit-book-field");
    assert.equal(fields.display, "grid");
    assert.match(css, /\.edit-book-body \.edit-book-field\s*\{[^}]*grid-template-columns:\s*minmax\(120px, 180px\) minmax\(0, 1fr\)/s);
    assert.match(css, /@media \(max-width: 540px\)[\s\S]*\.edit-book-body \.edit-book-field\s*\{[^}]*grid-template-columns:\s*1fr/s);
    assert.equal(cssDeclarations(css, ".edit-book-body .edit-book-text-field")["align-items"], "start");
    assert.equal(cssDeclarations(css, ".edit-book-actions").position, "sticky");
    const clear = cssDeclarations(css, ".edit-book-cover-clear");
    assert.equal(clear.width, "24px");
    assert.equal(clear.height, "24px");
    assert.equal(clear["aspect-ratio"], "1");
  });

  it("defines sticky desktop vocabulary action columns with Pocket overrides", () => {
    const table = cssDeclarations(css, ".vocab-table");
    assert.equal(table["min-width"], "1260px");
    assert.equal(table["table-layout"], "fixed");
    assert.equal(cssDeclarations(css, ".vocab-table th:nth-child(4)").width, "320px");
    assert.equal(cssDeclarations(css, ".vocab-table th:nth-child(5)").width, "340px");
    const actions = cssDeclarations(css, ".vocab-table td:last-child");
    assert.equal(actions.position, "sticky");
    assert.equal(actions.right, "0");
    assert.equal(actions.width, "340px");
    assert.equal(cssDeclarations(css, ".vocab-table th:last-child").position, "sticky");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .vocab-table td:last-child").position, "static");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .vocab-table th:last-child").right, "auto");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .vocab-table")["min-width"], "0");
    assert.match(desktopWindow, /\.min_inner_size\(960\.0, 640\.0\)/);
  });

  it("defines status-specific SRS hover colors", () => {
    assert.equal(cssDeclarations(css, ".sm2-grades .status-button.sm2-grade-1:hover").background, "var(--red-soft)");
    assert.equal(cssDeclarations(css, ".sm2-grades .status-button.sm2-grade-3:hover").background, "var(--amber-soft)");
    assert.equal(cssDeclarations(css, ".sm2-grades .status-button.sm2-grade-5:hover").background, "var(--green-soft)");
    assert.match(cssDeclarations(css, ".sm2-grades .status-button.sm2-grade-1:hover")["border-color"], /var\(--red\)/);
    assert.equal(hasCssSelector(css, ':root[data-theme="dark"] .sm2-grades .status-button.sm2-grade-1:hover'), false);
    assert.equal(hasCssSelector(css, ".sm2-grade:hover"), false);
  });
});

describe("desktop platform contracts", () => {
  it("keeps Linux windows matched to the Word Hunter desktop icon", () => {
    assert.equal(tauriConfig.identifier, "com.wordhunter.app");
    assert.equal(tauriConfig.app.enableGTKAppId, true);
    assert.match(flatpakDesktop, /^Icon=com\.wordhunter\.app$/m);
    assert.match(flatpakDesktop, /^StartupWMClass=com\.wordhunter\.app$/m);
    assert.match(flatpakMeta, /<icon type="stock">com\.wordhunter\.app<\/icon>/);
    assert.match(flatpakMeta, /<category>Education<\/category>/);
    assert.match(flatpakMeta, /<category>Languages<\/category>/);
    assert.match(flatpakMeta, /<release version="1\.0\.5~rc\.2"[^>]*type="development">/);
    assert.match(tomlSection(cargoToml, "target.'cfg(target_os = \"linux\")'.dependencies"), /gdkwayland-sys = \{ version = "0\.18", features = \["v3_24_22"\] \}/);
    assert.match(desktopWindow, /const LINUX_DESKTOP_APP_ID: &str = "com\.wordhunter\.app"/);
    assert.match(desktopWindow, /set_linux_program_name\(\)/);
    assert.match(desktopWindow, /g_set_prgname\(app_id\.as_ptr\(\)\)/);
    assert.match(desktopWindow, /install_linux_window_workarounds\(&window\)/);
    assert.match(desktopWindow, /allow_wayland_titlebar_button_events\(&gtk_window\)/);
    assert.match(desktopWindow, /connect_realize\(\|gtk_window\|/);
    assert.match(desktopWindow, /connect_map\(\|gtk_window\|/);
    assert.match(desktopWindow, /fn relax_event_box_overlays\(widget: &gtk::Widget\)/);
    assert.match(desktopWindow, /widget\.clone\(\)\.downcast::<gtk::EventBox>\(\)/);
    assert.match(desktopWindow, /widget\.clone\(\)\.downcast::<gtk::Container>\(\)/);
    assert.match(desktopWindow, /set_above_child\(false\)/);
    assert.match(desktopWindow, /gdk_wayland_window_set_application_id/);
  });
});

describe("desktop PDF reader contracts", () => {
  it("executes PDF view-mode and bounded zoom preferences", () => {
    resetBehaviorState();
    const stage = { style: {} };
    const page = { style: {}, getBoundingClientRect() { return { width: 0, height: 0 }; } };
    const zoomValue = { textContent: "" };
    const zoomOut = { disabled: false };
    const zoomIn = { disabled: false };
    els.readerText = {
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
      querySelector(selector) {
        return {
          ".pdf-ocr-stage": stage,
          ".pdf-ocr-page": page,
          "[data-pdf-zoom-value]": zoomValue,
          "[data-pdf-zoom='out']": zoomOut,
          "[data-pdf-zoom='in']": zoomIn
        }[selector] || null;
      }
    };

    assert.equal(getPdfOcrViewMode(), "overlay");
    assert.equal(setPdfOcrViewMode("text", { commit: false }), "text");
    assert.equal(getPdfOcrViewMode(), "text");
    assert.equal(setPdfOcrViewMode("invalid", { commit: false }), "overlay");

    assert.equal(setPdfOcrZoom(99, { commit: false }), 3);
    assert.equal(getPdfOcrZoom(), 3);
    assert.equal(stage.style.width, "300.00%");
    assert.equal(page.style.width, "100.00%");
    assert.equal(zoomValue.textContent, "300%");
    assert.equal(zoomIn.disabled, true);

    assert.equal(setPdfOcrZoom(0, { commit: false }), 0.75);
    assert.equal(stage.style.width, "100.00%");
    assert.equal(page.style.width, "75.00%");
    assert.equal(zoomOut.disabled, true);
  });

  it("declares compact OCR markers and overlay/text layouts", () => {
    assert.equal(cssDeclarations(css, ".word-token.status-new")["box-shadow"], "inset 0 -0.28em var(--token-new-bg, var(--amber-soft))");
    assert.equal(cssDeclarations(css, ".pdf-ocr-toolbar").position, "sticky");
    assert.equal(cssDeclarations(css, ".pdf-ocr-toolbar")["justify-content"], "flex-end");
    assert.equal(cssDeclarations(css, ".reader-text.pdf-text-layer-reader")["white-space"], "pre-wrap");
    assert.equal(cssDeclarations(css, ".pdf-text-page").width, "min(100%, 920px)");
    assert.equal(cssDeclarations(css, ".pdf-text-page").margin, "0 auto");
    assert.equal(cssDeclarations(css, ".pdf-ocr-stage")["justify-items"], "center");
    assert.equal(cssDeclarations(css, ".pdf-ocr-stage")["touch-action"], "pan-x pan-y");
    const word = cssDeclarations(css, ".word-token.pdf-ocr-word");
    assert.equal(word["--pdf-ocr-mark-height"], "clamp(1px, 8%, 3px)");
    assert.equal(word["--pdf-ocr-mark-bottom"], "6%");
    assert.equal(word["box-shadow"], "none !important");
    assert.equal(word["font-size"], "0");
    assert.equal(word["line-height"], "0");
    const marker = cssDeclarations(css, ".word-token.pdf-ocr-word::after");
    assert.equal(marker.bottom, "var(--pdf-ocr-mark-bottom)");
    assert.equal(marker.height, "var(--pdf-ocr-mark-height)");
    assert.equal(marker["border-radius"], "999px");
    assert.equal(cssDeclarations(css, ".word-token.pdf-ocr-word.status-new::after").background, "var(--token-new-bg, var(--amber-soft))");
    assert.equal(findElement(html, (tag) => attribute(tag, "id") === "reader-pdf-ocr-line-spacing-slider"), null);
    assert.equal(hasCssSelector(css, ".reader-ocr-line"), false);
  });

  it("statically declares PDF overlay/text rendering controls", () => {
    const renderer = readFileSync(new URL("../../dist/web/js/reader/pdf-ocr-renderer.js", import.meta.url), "utf8");
    const correction = readFileSync(new URL("../../dist/web/js/reader/ocr-correction.js", import.meta.url), "utf8");
    assert.match(renderer, /const PDF_TEXT_LAYER_BOUNDS_VERSION = "text-glyph-v2"/);
    assert.match(renderer, /readerEls\.readerText\.classList\.toggle\("pdf-text-layer-reader", !overlayMode\)/);
    assert.match(renderer, /function renderPdfOcrTextMode\(/);
    assert.match(renderer, /function renderPdfOcrTextTokens\(/);
    assert.match(renderer, /const globalIndex = overlayWordIndexes\[index\]/);
    assert.match(renderer, /globalIndex - globalOffset/);
    assert.doesNotMatch(renderer, /globalOffset \+ index \+ 1/);
    assert.match(renderer, /classifications\.get\(index \* 2\)\?\.key/);
    assert.match(renderer, /data-pdf-view-mode="\$\{escapeAttribute\(targetMode\)\}"/);
    assert.match(renderer, /data-pdf-zoom="out"/);
    assert.match(renderer, /data-pdf-zoom="reset"/);
    assert.match(renderer, /data-pdf-zoom="in"/);
    assert.match(renderer, /data-pdf-correct/);
    assert.match(renderer, /data-pdf-correct-sentence/);
    assert.match(renderer, /data-pdf-page-word-index/);
    assert.match(renderer, /icon\("sentenceEdit", 16\)/);
    assert.match(renderer, /effectivePdfPageText\(page\)/);
    assert.match(renderer, /aria-label="\$\{escapeAttribute\(raw\)\}"><\/button>`/);
    assert.match(correction, /sourcePageText\.slice\(sentenceRange\.start, sentenceRange\.end\)/);
    assert.match(correction, /replacePdfTextRange\(sourcePageText, sentenceRange, textarea\.value\)/);
    assert.match(correction, /if \(sentenceMode && !sentenceRange\)\s*return Promise\.resolve\(false\)/);
  });

  it("statically routes a missing desktop OCR runner to text-layer import", () => {
    const backend = readFileSync(new URL("../../src-tauri/src/pdf_ocr/mod.rs", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");
    const response = readFileSync(new URL("../../src-tauri/src/response.rs", import.meta.url), "utf8");
    const server = readFileSync(new URL("../../src-tauri/src/server.rs", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const importer = readFileSync(new URL("../../dist/web/js/events/book-import.js", import.meta.url), "utf8");
    assert.match(tomlSection(cargoToml, "dependencies"), /pdf-extract = "0\.12"/);
    assert.match(flatpakManifest, /--filesystem=host-os:ro/);
    assert.match(backend, /let result = import_text_layer_pdf\(/);
    assert.match(backend, /pdf_extract::output_doc_page\(&document, &mut output, page_num\)/);
    assert.doesNotMatch(backend, /pdf_extract::extract_text_from_mem_by_pages\(data\)/);
    assert.match(backend, /merge_words_using_plain_text\(/);
    assert.match(backend, /const TEXT_LAYER_BOUNDS_VERSION: &str = "text-glyph-v2"/);
    assert.match(backend, /render_text_layer_page_images\([\s\S]*context\.store,[\s\S]*context\.asset_book_id,[\s\S]*&pages,[\s\S]*context\.job_id,[\s\S]*context\.cancellations/);
    assert.match(backend, /PathBuf::from\("\/run\/host\/usr\/bin\/pdftoppm"\)/);
    assert.match(backend, /save_book_import_image_bytes\(book_id, image_name, &image_bytes\)/);
    assert.match(backend, /\(Vec::new\(\), "pdf-text-layer", false\)/);
    assert.match(backend, /if let Err\(runner_error\) = result/);
    assert.match(router, /Err\(error\) => response::error_response\(request, 422, &error\)/);
    assert.match(router, /state\.ocr_slot\.try_lock\(\)/);
    assert.match(router, /"\/__import\/pdf_ocr\/raw"/);
    assert.match(router, /read_body_limited\(&mut request, MAX_RAW_PDF_BODY\)/);
    assert.match(router, /"\/__store\/wipe"[\s\S]*state\.ocr_slot\.try_lock\(\)/);
    assert.match(response, /pub fn read_json_limited\(/);
    assert.match(server, /pub ocr_slot: Mutex<\(\)>/);
    assert.match(handlers, /Cannot move the data folder while a PDF import is running/);
    assert.match(importer, /catch \(error\) \{\s*await deleteStoredText\(id\)/);
    assert.match(importer, /body: file/);
    assert.match(importer, /`\/__import\/pdf_ocr\/raw\?\$\{params\}`/);
  });
});
