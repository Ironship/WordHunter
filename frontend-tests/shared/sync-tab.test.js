import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
const pocketCss = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");
const localeCodes = ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"];

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

function textContent(element) {
  return element
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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
  const attributes = new Map();
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
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    ...extra
  };
}

const documentListeners = new Map();
globalThis.window = {
  __qtBridge: false,
  location: { search: "" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false, addEventListener() {} }; }
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "" }
});
globalThis.document = {
  body: { classList: fakeClassList(), contains() { return false; } },
  documentElement: {
    dataset: { platform: "desktop" },
    style: { zoom: "1", setProperty() {} },
    classList: fakeClassList()
  },
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};

const { els } = await import("../../dist/web/js/dom.js");
const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { handleGlobalKeys } = await import("../../dist/web/js/events/keyboard/global-keys.js");
const { bindNavigationEvents } = await import("../../dist/web/js/events/navigation.js");
const {
  importAnkiTsv,
  parseAnkiTsvLocally,
  saveWithAndroidBridge
} = await import("../../dist/web/js/sync-actions.js");

function setupRenderControls() {
  const syncNav = control({ dataset: { view: "sync" } });
  const syncView = control({ id: "sync-view", dataset: { titleKey: "nav.sync" } });
  els.navItems = [syncNav];
  els.views = [syncView];
  els.pageTitle = control();
  els.overallCount = control();
  els.pillKnown = control();
  els.pillLearning = control();
  els.pillNew = control();
  els.themeToggle = control();
  els.prefTheme = control();
  els.prefLocales = [];
  els.prefLearningLanguages = [];
  els.ankiExportStatusFilters = [];
  els.prefLearningColors = [];
  for (const key of ["prefFont", "prefLineHeight", "prefFontSize", "prefHighlight", "prefAutoLearn", "prefCardStats"]) {
    els[key] = control();
  }
  els.syncDirectory = control();
  els.syncStatus = control();
  return { syncNav, syncView };
}

function resetState() {
  replaceState({ ...createDefaultState(), currentView: "library", syncDirectory: "/tmp/WordHunterSync" }, { save: false });
  document.documentElement.dataset.platform = "desktop";
  document.documentElement.classList = fakeClassList();
}

describe("Anki TSV compatibility", () => {
  it("rejects oversized TSV files before allocating a FileReader", () => {
    let readers = 0;
    globalThis.FileReader = class FileReader { constructor() { readers += 1; } };
    const target = { files: [{ size: 33 * 1024 * 1024 }], value: "large.tsv" };

    importAnkiTsv({ target });

    assert.equal(readers, 0);
    assert.equal(target.value, "");
  });

  it("waits for the durable state commit before reporting Anki import success", () => {
    const source = readFileSync(new URL("../../dist/web/js/sync-actions.js", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function importAnkiTsv"), source.indexOf("export function parseAnkiTsvLocally"));
    assert.ok(body.indexOf("await saveStateAndReloadBridge()") < body.indexOf("toast.importDoneCount"));
    assert.match(body, /Anki import recovery reload failed/);
  });

  it("parses an optional article column after every localized first-column header", () => {
    for (const header of ["Word", "Słowo", "Wort", "Palabra", "Mot", "Parola", "単語", "Слово"]) {
      const rows = parseAnkiTsvLocally(`${header}\tTranslation\tContext\tArticle\nhaus\thouse\texample\tdas\n`);
      assert.deepEqual(rows, [{ word: "haus", translation: "house", context: "example", article: "das" }], header);
    }
  });

  it("does not discard a headerless first row whose word resembles a localized header", () => {
    assert.deepEqual(parseAnkiTsvLocally("Mot\tword\texample\tle\n"), [{
      word: "Mot",
      translation: "word",
      context: "example",
      article: "le"
    }]);
  });

  it("keeps legacy three-column rows compatible and only treats the first non-empty row as a header", () => {
    assert.deepEqual(parseAnkiTsvLocally("\nalpha\talef\texample\nWord\tterm\tcontext\n"), [
      { word: "alpha", translation: "alef", context: "example", article: "" },
      { word: "Word", translation: "term", context: "context", article: "" }
    ]);
  });
});

describe("Pocket export memory guard", () => {
  it("rejects oversized UTF-8 data before calling the Kotlin bridge", async () => {
    let bridgeCalls = 0;
    window.WordHunterAndroid = {
      saveExport() {
        bridgeCalls += 1;
        return true;
      }
    };
    const oversized = "€".repeat(11 * 1024 * 1024);

    await assert.rejects(
      saveWithAndroidBridge(oversized, "backup.json", "application/json"),
      /32 MB safety limit/
    );
    assert.equal(bridgeCalls, 0);
    delete window.WordHunterAndroid;
  });
});
describe("Sync navigation behavior", () => {
  it("navigates to and renders Sync from its nav item and Y shortcut", () => {
    resetState();
    const { syncNav, syncView } = setupRenderControls();
    bindNavigationEvents();

    syncNav.listener("click")();
    assert.equal(state.currentView, "sync");
    assert.equal(syncNav.classList.contains("active"), true);
    assert.equal(syncView.classList.contains("active"), true);
    assert.equal(els.syncDirectory.textContent, "settings.syncFolderPath");

    state.currentView = "library";
    let prevented = 0;
    const handled = handleGlobalKeys({
      ctrlKey: false,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      preventDefault() { prevented += 1; }
    }, "y", false);
    assert.equal(handled, true);
    assert.equal(prevented, 1);
    assert.equal(state.currentView, "sync");
    assert.equal(syncView.classList.contains("active"), true);
  });

  it("changes themes without rebuilding the active Reader view", () => {
    resetState();
    setupRenderControls();
    state.currentView = "reader";
    let readerRenderAttempts = 0;
    els.readerText = {
      get dataset() {
        readerRenderAttempts += 1;
        return {};
      }
    };
    bindNavigationEvents();

    els.themeToggle.listener("click")();

    assert.equal(state.currentView, "reader");
    assert.equal(state.preferences.theme, "alternative-familiar");
    assert.equal(document.documentElement.dataset.themePref, "alternative-familiar");
    assert.equal(els.prefTheme.value, "alternative-familiar");
    assert.equal(readerRenderAttempts, 0);
  });

  it("announces wholesale state replacements so global preferences can be reapplied", () => {
    const dispatched = [];
    window.dispatchEvent = (event) => dispatched.push(event.type);
    try {
      resetState();
      assert.ok(dispatched.includes("wordhunter:state-replaced"));
    } finally {
      window.dispatchEvent = () => {};
    }
  });
});

describe("Sync structural contracts", () => {
  it("keeps the workflow in a dedicated Sync view rather than Settings", () => {
    const navItem = elementByAttribute(html, "data-view", "sync", "button");
    const settingsSection = elementById(html, "settings-view");
    const syncSection = elementById(html, "sync-view");

    assert.equal(attribute(openingTag(navItem), "data-i18n-attr"), "title=nav.sync");
    assert.equal(attribute(openingTag(syncSection), "data-title-key"), "nav.sync");
    elementByAttribute(settingsSection, "data-i18n", "settings.groupLocalData");
    for (const id of ["syncthing-setup-wizard", "sync-directory", "force-sync"]) {
      assert.equal(findElement(settingsSection, (tag) => attribute(tag, "id") === id), null);
      elementById(syncSection, id);
    }
    assert.equal(findElement(settingsSection, (tag) => attribute(tag, "data-i18n") === "settings.groupSync"), null);
    elementByAttribute(syncSection, "data-i18n", "settings.groupSync");
    elementById(syncSection, "sync-conflicts-panel");
    elementById(syncSection, "recovery-status-panel");
  });

  it("keeps the localized guide sections inside the Sync view", () => {
    const syncSection = elementById(html, "sync-view");
    const heading = elementById(syncSection, "sync-guide-heading");
    assert.equal(attribute(openingTag(heading), "data-i18n"), "syncGuide.heading");
    for (const key of ["sourceOfTruth", "pcTitle", "androidTitle", "verifyTitle", "troubleTitle"]) {
      const guideElement = elementByAttribute(syncSection, "data-i18n", `syncGuide.${key}`);
      assert.ok(textContent(guideElement), `syncGuide.${key} fallback copy should not be empty`);
    }
    const helpSection = elementById(html, "help-view");
    elementByAttribute(helpSection, "data-i18n-html", "help.navKeys.sync");
  });

  it("defines desktop and Pocket Sync layout declarations", () => {
    const grid = cssDeclarations(styles, ".sync-page-grid");
    assert.equal(grid["grid-template-columns"], "minmax(0, 1.15fr) minmax(360px, 0.85fr)");
    assert.equal(grid["align-items"], "start");
    assert.equal(cssDeclarations(styles, "#sync-view.active > .sync-page-grid")["min-height"], "0");
    const pocketNav = cssDeclarations(pocketCss, ".pocket-mode .nav-list");
    assert.equal(pocketNav.display, "grid");
    assert.equal(pocketNav["grid-template-columns"], "minmax(0, 1fr)");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .sidebar").visibility, "hidden");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode.pocket-navigation-open .sidebar").visibility, "visible");
  });
});

describe("Sync wizard contracts", () => {
  it("keeps title copy free of duplicated visual step numbers", () => {
    const wizard = elementById(elementById(html, "sync-view"), "syncthing-setup-wizard");
    for (let step = 1; step <= 4; step += 1) {
      const stepElement = elementByAttribute(wizard, "data-step", String(step));
      const title = elementByAttribute(stepElement, "data-i18n", `settings.syncWizStep${step}Title`);
      assert.doesNotMatch(textContent(title), /^\s*\d+\.\s+/);
    }

    for (const code of localeCodes) {
      const dict = JSON.parse(readFileSync(new URL(`../../dist/web/i18n/${code}.json`, import.meta.url), "utf8"));
      for (let step = 1; step <= 4; step += 1) {
        assert.doesNotMatch(dict.settings[`syncWizStep${step}Title`], /^\s*\d+\.\s+/, `${code} wizard title ${step}`);
      }
    }
  });

  it("attaches each desktop and Pocket number to its own wizard step", () => {
    const wizard = elementById(elementById(html, "sync-view"), "syncthing-setup-wizard");
    const expected = new Map([
      ["1", { desktop: "1", pocket: "1" }],
      ["2", { shared: "2" }],
      ["3", { shared: "3" }],
      ["4", { desktop: "4", pocket: "2" }]
    ]);
    for (const [step, numbers] of expected) {
      const stepElement = elementByAttribute(wizard, "data-step", step);
      const number = elementByClass(stepElement, "wizard-step-num", "span");
      if (numbers.shared) {
        assert.equal(textContent(number), numbers.shared);
      } else {
        assert.equal(textContent(elementByClass(number, "wizard-step-num-desktop", "span")), numbers.desktop);
        assert.equal(textContent(elementByClass(number, "wizard-step-num-pocket", "span")), numbers.pocket);
      }
    }

    const wizardRule = cssDeclarations(styles, ".syncthing-wizard");
    assert.equal(wizardRule.display, "grid");
    assert.equal(wizardRule.gap, "0.75rem");
    const stepRule = cssDeclarations(styles, ".syncthing-wizard-step");
    assert.equal(stepRule.display, "grid");
    assert.equal(stepRule["grid-template-columns"], "2rem minmax(0, 1fr)");
    assert.equal(stepRule["align-items"], "start");
    const numberRule = cssDeclarations(styles, ".wizard-step-num");
    assert.equal(numberRule.display, "inline-grid");
    assert.equal(numberRule["place-items"], "center");
    assert.equal(numberRule["border-radius"], "999px");
    assert.equal(cssDeclarations(styles, ".syncthing-wizard-step-body")["min-width"], "0");
    assert.equal(cssDeclarations(styles, ".wizard-step-num-pocket").display, "none");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .wizard-step-num-desktop").display, "none");
    assert.equal(cssDeclarations(pocketCss, ".pocket-mode .wizard-step-num-pocket").display, "inline");
  });

  it("keeps localized Android instructions independent of hidden desktop step 3", () => {
    const hiddenDesktopStepRef = /(?:step|krok\w*|schritt|étape|paso|passaggio|шаг\w*|крок\w*|ステップ)\s*3/i;
    for (const code of localeCodes) {
      const dict = JSON.parse(readFileSync(new URL(`../../dist/web/i18n/${code}.json`, import.meta.url), "utf8"));
      const pocketWizardCopy = [
        dict.settings.syncWizStep4Desc,
        dict.settings.syncWizAndroid1,
        dict.settings.syncWizAndroid2,
        dict.settings.syncWizAndroid3,
        dict.settings.syncWizAndroid4,
        dict.settings.syncWizAndroid5
      ].join(" ");
      assert.doesNotMatch(pocketWizardCopy, hiddenDesktopStepRef, `${code} Android wizard copy should not reference hidden step 3`);
    }

    const syncSection = elementById(html, "sync-view");
    const instruction = elementByAttribute(syncSection, "data-i18n", "settings.syncWizAndroid3");
    assert.match(textContent(instruction), /^Na PC otwórz WordHunter > Synchronizacja/);
  });
});
