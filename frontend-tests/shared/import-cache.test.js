import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: true,
  __bridgeState: null,
  WH_TOKEN: "",
  confirm: () => true,
  dispatchEvent() {},
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { search: "" }
};
globalThis.document = {
  documentElement: { dataset: { platform: "desktop" }, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { STATE_SCHEMA_VERSION, createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { buildSavePayload } = await import("../../dist/web/js/api.js");
const { bookTexts } = await import("../../dist/web/js/books.js");
const { els } = await import("../../dist/web/js/dom.js");
const { importStateFile } = await import("../../dist/web/js/sync-actions.js");

els.navItems = [];
els.views = [];
for (const key of ["pageTitle", "overallCount", "pillKnown", "pillLearning", "pillNew"]) {
  els[key] = { textContent: "" };
}

describe("state import cache invalidation", () => {
  it("clears cached user-book bodies after a bridge import commits", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.userBooks = [{ id: "same-user-book", title: "Imported", textUrl: "/imported-body" }];
    imported.userBooks = imported.profiles.de.userBooks;
    const current = createDefaultState();
    current.currentView = "test";
    current.profiles.de.userBooks = [{ id: "same-user-book", title: "Old" }];
    current.userBooks = current.profiles.de.userBooks;
    replaceState(current, { save: false });
    bookTexts.set("same-user-book", "old cached body");
    globalThis.fetch = async (url, options) => {
      if (url === "/__store/save") return { ok: true, json: async () => ({}) };
      if (url === "/__store/save?snapshot=1") {
        return { ok: true, json: async () => ({ snapshot: JSON.parse(options.body) }) };
      }
      return { ok: true, text: async () => `${url} ${"word ".repeat(50)}` };
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() {
        this.result = JSON.stringify(imported);
        this.onLoad();
      }
    };

    importStateFile({ target: { files: [{ size: 1024 }], value: "backup.json" } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(bookTexts.get("same-user-book"), /^\/imported-body/);
    assert.equal(state.userBooks[0].title, "Imported");
  });

  it("reloads canonical current books when a bridge import fails", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    const current = createDefaultState();
    current.currentView = "test";
    current.profiles.de.userBooks = [{ id: "kept-user-book", title: "Current", textUrl: "/current-body" }];
    current.userBooks = current.profiles.de.userBooks;
    replaceState(current, { save: false });
    bookTexts.set("kept-user-book", "current cached body");
    const currentSnapshot = buildSavePayload(current);
    globalThis.fetch = async (url) => {
      if (url === "/__store/save") return { ok: true, json: async () => ({}) };
      if (url === "/__store/save?snapshot=1") return { ok: false, status: 500 };
      if (url === "/__store/load") return { ok: true, json: async () => currentSnapshot };
      return { ok: true, text: async () => `${url} ${"word ".repeat(50)}` };
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() {
        this.result = JSON.stringify(imported);
        this.onLoad();
      }
    };
    const previousWarn = console.warn;
    console.warn = () => {};

    try {
      importStateFile({ target: { files: [{ size: 1024 }], value: "backup.json" } });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.warn = previousWarn;
    }

    assert.match(bookTexts.get("kept-user-book"), /^\/current-body/);
    assert.equal(state.userBooks[0].title, "Current");
  });
});
