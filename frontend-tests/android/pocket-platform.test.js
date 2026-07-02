import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClassList } from "./helpers.js";

describe("Android Pocket platform", () => {
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

    const { detectPlatform } = await import("../../src/web/js/platform.js");

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

    const { applyPlatformUi } = await import("../../src/web/js/platform.js");
    applyPlatformUi();

    assert.equal(document.documentElement.dataset.platform, "android");
    assert.equal(document.documentElement.classList.contains("pocket-mode"), true);
    assert.equal(importFile.attrs.accept.includes(".txt"), true);
  });

  it("enables pocket mode from query override and limits mobile import", async () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
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

    const { applyPlatformUi, detectPlatform } = await import("../../src/web/js/platform.js");

    assert.equal(detectPlatform(), "android");
    assert.equal(document.documentElement.dataset.platform, "android");
    assert.equal(document.documentElement.classList.contains("pocket-mode"), true);
    assert.match(html, /class="setting-row desktop-only-setting"[\s\S]*id="pref-ui-scale"/);
    assert.match(html, /class="setting-row toggle-row desktop-only-setting"[\s\S]*id="pref-touch-controls"/);
    assert.match(html, /id="reader-word-panel-toggle"[\s\S]*desktop-only-control/);
    assert.match(html, /class="setting-row toggle-row desktop-only-setting"[\s\S]*id="pref-use-edge-tts"/);
    assert.match(html, /class="setting-row toggle-row desktop-only-setting"[\s\S]*id="pref-offline-translator"/);
    assert.match(html, /class="data-action-row desktop-only-setting"[\s\S]*id="check-updates"/);
    assert.match(html, /class="muted-copy desktop-only-setting"[\s\S]*data-i18n="settings\.dataFolderHint"/);
    assert.match(html, /id="choose-data-directory"[\s\S]*desktop-only-control|desktop-only-control[\s\S]*id="choose-data-directory"/);
    assert.match(html, /id="export-state"[\s\S]*desktop-only-control|desktop-only-control[\s\S]*id="export-state"/);
    assert.match(html, /id="export-anki-tsv"[\s\S]*desktop-only-control|desktop-only-control[\s\S]*id="export-anki-tsv"/);
    const autoAddLearning = html.match(/<label class="([^"]*)"[\s\S]*?<input id="pref-auto-add-learning"/);
    assert.ok(autoAddLearning);
    assert.doesNotMatch(autoAddLearning[1], /desktop-only-setting/);
    assert.match(css, /\.pocket-mode \.desktop-only-setting[\s\S]*display: none/);
    assert.match(css, /\.pocket-mode \.desktop-only-control[\s\S]*display: none/);

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

    const { applyPlatformUi, detectPlatform } = await import("../../src/web/js/platform.js");
    detectPlatform();
    applyPlatformUi();

    openButton.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), true);
    assert.equal(openButton.attrs["aria-expanded"], "true");

    closeButton.listeners.click[0]();
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), false);

    listeners.touchstart[0]({ touches: [{ clientX: 400, clientY: 200 }] });
    listeners.touchend[0]({ changedTouches: [{ clientX: 250, clientY: 205 }] });
    assert.equal(document.documentElement.classList.contains("pocket-import-open"), true);
  });

  it("routes Pocket PDF import through an Android-rendered overlay", () => {
    const source = readFileSync(new URL("../../src/web/js/events/book-import.js", import.meta.url), "utf8");
    const backend = readFileSync(new URL("../../src-tauri/src/platform/android_backend/pdf_ocr.rs", import.meta.url), "utf8");

    assert.match(source, /const androidPdfOverlay = isAndroidPlatform\(\);/);
    assert.match(source, /if \(!androidPdfOverlay && !await confirmWholeBookOcr\(\)\) return false;/);
    assert.match(source, /renderAndSaveAndroidPdfPages\(data, id, pages\)/);
    assert.match(source, /bridge\.beginPdfRender\(sessionId, data\)/);
    assert.match(source, /bridge\.renderPdfPage\(sessionId, index, 1400\)/);
    assert.match(source, /"\/__book\/image"/);
    assert.match(source, /pdfOcrPages: hasOverlayPages \? pages : undefined/);
    assert.match(source, /pdfOcrEngine: hasOverlayPages \? ocrEngine : ""/);
    assert.match(backend, /let \(pages, page_count, truncated\) = extract_overlay_pages\(&data, max_pages\)\?/);
    assert.match(backend, /pdf_extract::extract_text_from_mem_by_pages\(data\)/);
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
