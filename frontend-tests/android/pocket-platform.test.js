import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClassList } from "./helpers.js";

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

function elementContent(html, tagName) {
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const open = openPattern.exec(html);
  assert.ok(open, `Missing <${tagName}>`);
  const contentStart = open.index + open[0].length;
  const closePattern = new RegExp(`</${tagName}\\s*>`, "i");
  const close = closePattern.exec(html.slice(contentStart));
  assert.ok(close, `Missing </${tagName}>`);
  return html.slice(contentStart, contentStart + close.index);
}

function assertSourceOrder(source, before, after) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `Missing source marker: ${before}`);
  assert.notEqual(afterIndex, -1, `Missing source marker: ${after}`);
  assert.ok(beforeIndex < afterIndex, `Expected ${before} before ${after}`);
}

describe("Android Pocket platform", () => {
  it("snaps the word card by drag velocity and resting position", async () => {
    const { resolvePocketWordSheetState } = await import("../../dist/web/js/platform.js");

    assert.equal(resolvePocketWordSheetState(-90, -0.8, 500, 80, 560), "expanded");
    assert.equal(resolvePocketWordSheetState(90, 0.8, 140, 80, 560), "collapsed");
    assert.equal(resolvePocketWordSheetState(-20, -0.02, 240, 80, 560), "expanded");
    assert.equal(resolvePocketWordSheetState(20, 0.02, 420, 80, 560), "collapsed");
    assert.equal(resolvePocketWordSheetState(30, -0.8, 300, 80, 560), "expanded");
  });

  it("defines centered, non-scrollable critical boot styles", () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const inlineCss = elementContent(html, "style");
    const bootRoot = declarationBlock(css, "html.app-booting");
    const bootBody = declarationBlock(css, "html.app-booting body");
    const logo = declarationBlock(css, "html.app-booting body::after");

    assert.equal(declarationBlock(inlineCss, "html.app-booting").overflow, "hidden");
    assert.equal(declarationBlock(inlineCss, "html.app-booting .app-shell").visibility, "hidden");
    assert.equal(bootRoot.overflow, "hidden");
    assert.equal(bootRoot["overscroll-behavior"], "none");
    assert.equal(bootBody.position, "fixed");
    assert.equal(bootBody.inset, "0");
    assert.match(logo.inset, /^env\(safe-area-inset-top/);
    assert.equal(logo.margin, "auto");
    assert.equal(logo.left, undefined);
    assert.equal(logo.top, undefined);
    assert.doesNotMatch(logo.transform, /translate/);
  });

  it("detects Android from the native sync bridge when the user agent is generic", async () => {
    globalThis.window = {
      location: { search: "" },
      WordHunterAndroid: { chooseSyncFolder() {} }
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: {
        dataset: {},
        classList: createClassList()
      }
    };

    const { detectPlatform } = await import("../../dist/web/js/platform.js");

    assert.equal(detectPlatform(), "android");
    assert.equal(document.documentElement.classList.contains("pocket-mode"), true);
  });

  it("redetects Android when applying Pocket UI after the bridge appears", async () => {
    const importFile = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
    const importHint = { innerHTML: "" };

    globalThis.window = {
      location: { search: "" },
      WordHunterAndroid: { chooseSyncFolder() {} }
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: {
        dataset: { platform: "desktop" },
        classList: createClassList(),
        style: { zoom: "", setProperty(name, value) { this[name] = value; } }
      },
      getElementById(id) {
        if (id === "import-file") return importFile;
        if (id === "import-file-hint") return importHint;
        return null;
      },
      querySelector() { return null; }
    };

    const { applyPlatformUi } = await import("../../dist/web/js/platform.js");
    applyPlatformUi();

    assert.equal(document.documentElement.dataset.platform, "android");
    assert.equal(document.documentElement.classList.contains("pocket-mode"), true);
    assert.equal(importFile.attrs.accept.includes(".txt"), true);
  });

  it("marks desktop-only settings and controls in their own elements", () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../dist/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const desktopSettingParents = [
      ["pref-ui-scale", "label"],
      ["pref-touch-controls", "label"],
      ["pref-use-edge-tts", "label"],
      ["pref-offline-translator", "label"],
      ["check-updates", "section"]
    ];

    for (const [id, parentTag] of desktopSettingParents) {
      assert.ok(classTokens(ancestorOpeningTag(html, id, parentTag)).has("desktop-only-setting"), `${id} ${parentTag}`);
    }
    assert.ok(classTokens(ancestorOpeningTag(html, "choose-sync-directory", "details")).has("desktop-only-setting"));
    for (const id of ["reader-word-panel-toggle", "choose-data-directory"]) {
      assert.ok(classTokens(openingTagById(html, id)).has("desktop-only-control"), id);
    }
    for (const id of ["export-state", "export-anki-tsv"]) {
      assert.equal(classTokens(openingTagById(html, id)).has("desktop-only-control"), false, id);
    }
    assert.equal(classTokens(ancestorOpeningTag(html, "pref-auto-add-learning", "label")).has("desktop-only-setting"), false);
    assertSourceOrder(html, 'data-i18n="settings.groupLocalData"', 'id="choose-data-directory"');
    assertSourceOrder(html, 'id="choose-data-directory"', 'data-i18n="settings.groupBackup"');
    assert.equal(declarationBlock(css, ".pocket-mode .desktop-only-setting").display, "none");
    assert.equal(declarationBlock(css, ".pocket-mode .desktop-only-control").display, "none");
  });

  it("applies query-forced Pocket UI and mobile import policy", async () => {
    const importFile = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
    const importHint = { innerHTML: "" };
    const providerOptions = [
      { value: "offline", disabled: false, hidden: false },
      { value: "google", disabled: false, hidden: false },
      { value: "lmstudio", disabled: false, hidden: false }
    ];
    const translationProvider = {
      querySelectorAll() {
        return providerOptions.filter((option) => option.value === "offline" || option.value === "lmstudio");
      }
    };

    globalThis.window = { location: { search: "?platform=android" } };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: {
        dataset: {},
        classList: createClassList(),
        style: { zoom: "", setProperty(name, value) { this[name] = value; } }
      },
      getElementById(id) {
        if (id === "import-file") return importFile;
        if (id === "import-file-hint") return importHint;
        if (id === "pref-translation-provider") return translationProvider;
        return null;
      },
      querySelector() { return null; }
    };

    const { applyPlatformUi, detectPlatform } = await import("../../dist/web/js/platform.js");

    assert.equal(detectPlatform(), "android");
    assert.equal(document.documentElement.dataset.platform, "android");
    assert.equal(document.documentElement.classList.contains("pocket-mode"), true);

    applyPlatformUi();

    assert.equal(document.documentElement.style.zoom, "1");
    assert.equal(document.documentElement.style["--ui-scale"], "1");
    assert.equal(importFile.attrs.accept.includes(".pdf"), true);
    assert.equal(importFile.attrs.accept.includes("application/pdf"), true);
    assert.equal(importFile.attrs.accept.includes(".epub"), true);
    assert.equal(importFile.attrs.accept.includes(".mobi"), false);
    assert.equal(importFile.attrs.accept.includes(".txt"), true);
    assert.equal(importHint.innerHTML, "import.mobileFileHint");
    assert.equal(providerOptions.find((option) => option.value === "offline").disabled, true);
    assert.equal(providerOptions.find((option) => option.value === "lmstudio").hidden, true);
    assert.equal(providerOptions.find((option) => option.value === "google").hidden, false);
  });

  it("drags and toggles the Pocket word sheet without duplicate bindings", async (context) => {
    let now = 0;
    context.mock.method(globalThis.performance, "now", () => now);
    const listeners = {};
    const addListener = (target, type, handler) => {
      (target[type] ||= []).push(handler);
    };
    const handle = {
      attrs: {},
      listeners: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, handler) { addListener(this.listeners, type, handler); },
      setPointerCapture() {},
      releasePointerCapture() {}
    };
    const wrapper = {
      dataset: { pocketSheetState: "collapsed" },
      classList: createClassList(),
      style: {
        values: {},
        setProperty(name, value) { this.values[name] = value; },
        removeProperty(name) { delete this.values[name]; }
      },
      getBoundingClientRect() {
        return { top: this.dataset.pocketSheetState === "expanded" ? 80 : 560 };
      }
    };
    const root = {
      dataset: {},
      classList: createClassList(),
      style: { zoom: "", setProperty(name, value) { this[name] = value; } }
    };

    globalThis.window = {
      location: { search: "?platform=android" },
      addEventListener(type, handler) { addListener(listeners, type, handler); }
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: root,
      getElementById(id) { return id === "pocket-word-panel-sheet-handle" ? handle : null; },
      querySelector(selector) { return selector === "#reader-view .reader-sidebar-wrapper" ? wrapper : null; },
      querySelectorAll() { return []; }
    };

    const { applyPlatformUi, detectPlatform } = await import("../../dist/web/js/platform.js");
    detectPlatform();
    applyPlatformUi();
    applyPlatformUi();

    assert.equal(handle.listeners.click.length, 1);
    assert.equal(handle.listeners.pointerdown.length, 1);
    assert.equal(handle.attrs["aria-expanded"], "false");

    handle.listeners.click[0]({ preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "expanded");
    assert.equal(handle.attrs["aria-expanded"], "true");
    handle.listeners.click[0]({ preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "collapsed");

    handle.listeners.pointerdown[0]({ isPrimary: true, button: 0, pointerId: 4, clientX: 100, clientY: 550 });
    now = 16;
    handle.listeners.pointermove[0]({ pointerId: 4, clientX: 100, clientY: 250, preventDefault() {} });
    now = 32;
    handle.listeners.pointerup[0]({ pointerId: 4, clientX: 100, clientY: 250, preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "expanded");
    assert.equal(wrapper.classList.contains("pocket-word-sheet-dragging"), false);
    assert.equal(root.classList.contains("pocket-word-panel-open"), false);

    handle.listeners.keydown[0]({ key: "ArrowDown", preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "collapsed");

    now = 500;
    handle.listeners.pointerdown[0]({ isPrimary: true, button: 0, pointerId: 5, clientX: 100, clientY: 550 });
    now = 516;
    handle.listeners.pointermove[0]({ pointerId: 5, clientX: 100, clientY: 300, preventDefault() {} });
    now = 532;
    handle.listeners.pointermove[0]({ pointerId: 5, clientX: 100, clientY: 550, preventDefault() {} });
    now = 548;
    handle.listeners.pointerup[0]({ pointerId: 5, clientX: 100, clientY: 550, preventDefault() {} });
    handle.listeners.click[0]({ preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "collapsed");

    now = 1000;
    handle.listeners.pointerdown[0]({ isPrimary: true, button: 0, pointerId: 6, clientX: 100, clientY: 550 });
    now = 1016;
    handle.listeners.pointermove[0]({ pointerId: 6, clientX: 100, clientY: 250, preventDefault() {} });
    now = 3016;
    handle.listeners.pointerup[0]({ pointerId: 6, clientX: 100, clientY: 540, preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "collapsed");

    now = 4000;
    handle.listeners.pointerdown[0]({ isPrimary: true, button: 0, pointerId: 7, clientX: 100, clientY: 550 });
    now = 4016;
    handle.listeners.pointermove[0]({ pointerId: 7, clientX: 100, clientY: 400, preventDefault() {} });
    now = 4200;
    handle.listeners.pointerup[0]({ pointerId: 7, clientX: 100, clientY: 400, preventDefault() {} });
    assert.equal(wrapper.dataset.pocketSheetState, "collapsed");
  });

  it("opens and closes the Pocket import drawer from button and swipe", async () => {
    const listeners = {};
    const addListener = (target, type, handler) => {
      (target[type] ||= []).push(handler);
    };
    const importFile = { setAttribute() {} };
    const importHint = { innerHTML: "" };
    const importPanel = {};
    const openButton = {
      attrs: {},
      listeners: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, handler) { addListener(this.listeners, type, handler); }
    };
    const closeButton = {
      listeners: {},
      addEventListener(type, handler) { addListener(this.listeners, type, handler); }
    };

    globalThis.window = { location: { search: "?platform=android" }, innerWidth: 432 };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: {
        dataset: {},
        classList: createClassList(),
        style: { zoom: "", setProperty(name, value) { this[name] = value; } }
      },
      getElementById(id) {
        if (id === "import-file") return importFile;
        if (id === "import-file-hint") return importHint;
        if (id === "library-import-toggle") return openButton;
        if (id === "library-import-close") return closeButton;
        return null;
      },
      querySelector(selector) {
        if (selector === ".import-panel") return importPanel;
        if (selector === "#library-view.active") return {};
        return null;
      },
      addEventListener(type, handler) { addListener(listeners, type, handler); }
    };

    const { applyPlatformUi, detectPlatform } = await import("../../dist/web/js/platform.js");
    detectPlatform();
    applyPlatformUi();

    openButton.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), true);
    assert.equal(openButton.attrs["aria-expanded"], "true");

    listeners.keydown[0]({ key: "Escape" });
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), false);

    openButton.listeners.click[0]();
    closeButton.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), false);

    listeners.touchstart[0]({ touches: [{ clientX: 400, clientY: 200 }] });
    listeners.touchend[0]({ changedTouches: [{ clientX: 250, clientY: 205 }] });
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), true);
  });

  it("opens and closes the main Pocket navigation drawer", async () => {
    const listeners = {};
    const addListener = (target, type, handler) => {
      (target[type] ||= []).push(handler);
    };
    const navigation = {};
    const toggle = {
      attrs: {},
      listeners: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, handler) { addListener(this.listeners, type, handler); }
    };
    const navItem = {
      listeners: {},
      addEventListener(type, handler) { addListener(this.listeners, type, handler); }
    };

    globalThis.window = { location: { search: "?platform=android" } };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Desktop test" }
    });
    globalThis.document = {
      documentElement: {
        dataset: {},
        classList: createClassList(),
        style: { zoom: "", setProperty(name, value) { this[name] = value; } }
      },
      getElementById(id) {
        if (id === "app-navigation") return navigation;
        if (id === "pocket-navigation-toggle") return toggle;
        return null;
      },
      querySelector() { return null; },
      querySelectorAll(selector) { return selector === ".nav-item" ? [navItem] : []; },
      addEventListener(type, handler) { addListener(listeners, type, handler); }
    };

    const { applyPlatformUi, detectPlatform } = await import("../../dist/web/js/platform.js");
    detectPlatform();
    applyPlatformUi();

    toggle.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-navigation-open"), true);
    assert.equal(toggle.attrs["aria-expanded"], "true");

    navItem.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-navigation-open"), false);

    toggle.listeners.click[0]();
    listeners.keydown[0]({ key: "Escape" });
    assert.equal(document.documentElement.classList.contains("pocket-navigation-open"), false);
  });

  it("declares the Android PDF overlay integration contract", () => {
    const source = readFileSync(new URL("../../dist/web/js/events/book-import.js", import.meta.url), "utf8");
    const backend = readFileSync(new URL("../../src-tauri/src/platform/android_backend/pdf_ocr.rs", import.meta.url), "utf8");

    assert.match(source, /const androidPdfOverlay = isAndroidPlatform\(\);/);
    assert.match(source, /if \(!androidPdfOverlay && !await confirmWholeBookOcr\(\)\)\s*return false;/);
    assert.match(source, /renderAndSaveAndroidPdfPages\(data, id, pages\)/);
    assert.match(source, /bridge\.beginPdfRender\(sessionId, data\)/);
    assert.match(source, /bridge\.renderPdfPage\(sessionId, index, 1400\)/);
    assert.match(source, /new FileReader\(\)/);
    assert.match(source, /fetch\(`\/__import\/pdf_ocr\/raw\?\$\{params\}`/);
    assert.match(source, /MAX_POCKET_PDF_BYTES = 32 \* 1024 \* 1024/);
    assert.match(source, /error\?\.message === POCKET_PDF_SCAN_ERROR/);
    assert.match(source, /showPocketPdfScanDialog\(\)/);
    assert.match(source, /dialog\.showModal\(\)/);
    assert.match(source, /const blurb = androidPdfOverlay[\s\S]*t\("import\.pdfTextLayerBlurb"/);
    assert.match(source, /"\/__book\/image"/);
    assert.match(source, /pdfOcrPages: hasOverlayPages \? pages : undefined/);
    assert.match(source, /pdfOcrEngine: hasOverlayPages \? ocrEngine : ""/);
    assert.match(backend, /pub fn import_bytes\(/);
    assert.match(backend, /let \(pages, page_count, truncated\) = extract_overlay_pages\(data, max_pages\)\?/);
    assert.match(backend, /MAX_TEXT_LAYER_CHARS: usize = 2_000_000/);
    assert.doesNotMatch(backend, /pdf_extract::extract_text_from_mem_by_pages\(data\)/);
    assert.match(backend, /merge_words_using_plain_text\(/);
    assert.match(backend, /lookup_text\.contains\(&joined\) && !lookup_text\.contains\(&spaced\)/);
    assert.match(backend, /let baseline_y = position\.m32 as f32;/);
    assert.match(backend, /let y_top = baseline_y - font_height \* 0\.82;/);
    assert.match(backend, /bounds_version: TEXT_LAYER_BOUNDS_VERSION/);
    assert.doesNotMatch(backend, /marker_room/);
    assert.match(backend, /"pages": pages/);
    assert.match(backend, /image_name: format!\("pdf-page-\{:04\}\.png", page\.page_num\)/);
  });
});
