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
const { exportState, importStateFile } = await import("../../dist/web/js/sync-actions.js");

els.navItems = [];
els.views = [];
for (const key of ["pageTitle", "overallCount", "pillKnown", "pillLearning", "pillNew"]) {
  els[key] = { textContent: "" };
}

describe("state import cache invalidation", () => {
  it("exports custom books with their portable text bodies", async () => {
    const current = createDefaultState();
    const book = { id: "de-custom-portable", title: "Portable", lang: "de" };
    current.profiles.de.customTexts = [book];
    current.customTexts = current.profiles.de.customTexts;
    replaceState(current, { save: false });
    bookTexts.set(book.id, "Vollständiger tragbarer Buchtext");
    let exported = null;
    globalThis.fetch = async (url, options) => {
      if (url === "/__export/save") {
        exported = JSON.parse(options.body);
        return { ok: true, json: async () => ({ saved: true }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    await exportState();

    const backup = JSON.parse(exported.data);
    assert.equal(backup.backupIncludesTextBodies, true);
    assert.equal(backup.backupIncludesMediaFiles, false);
    assert.equal(backup.customTexts[0].text, undefined);
    assert.equal(backup.profiles.de.customTexts[0].text, "Vollständiger tragbarer Buchtext");
  });

  it("still exports words and settings when one stored book body is unavailable", async () => {
    const current = createDefaultState();
    const book = { id: "de-custom-missing", title: "Missing", lang: "de" };
    current.profiles.de.customTexts = [book];
    current.customTexts = current.profiles.de.customTexts;
    current.profiles.de.vocab = { haus: { status: "known" } };
    current.vocab = current.profiles.de.vocab;
    replaceState(current, { save: false });
    bookTexts.delete(book.id);
    let exported = null;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("/__book/text?id=")) {
        return { ok: true, json: async () => ({ text: "" }) };
      }
      if (url === "/__export/save") {
        exported = JSON.parse(options.body);
        return { ok: true, json: async () => ({ saved: true }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const previousWarn = console.warn;
    console.warn = () => {};
    try {
      await exportState();
    } finally {
      console.warn = previousWarn;
    }

    const backup = JSON.parse(exported.data);
    assert.equal(backup.backupIncludesTextBodies, false);
    assert.deepEqual(backup.backupMissingTextIds, [book.id]);
    assert.equal(backup.profiles.de.vocab.haus.status, "known");
  });

  it("bounds concurrent stored-text reads while creating a portable backup", async () => {
    const current = createDefaultState();
    const books = Array.from({ length: 7 }, (_, index) => ({
      id: `de-custom-concurrency-${index}`,
      title: `Book ${index}`,
      lang: "de"
    }));
    current.profiles.de.customTexts = books;
    current.customTexts = books;
    replaceState(current, { save: false });
    for (const book of books) bookTexts.delete(book.id);
    let active = 0;
    let peak = 0;
    let exported = null;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("/__book/text?id=")) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, json: async () => ({ text: `portable ${url}` }) };
      }
      if (url === "/__export/save") {
        exported = JSON.parse(options.body);
        return { ok: true, json: async () => ({ saved: true }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    await exportState();

    assert.equal(JSON.parse(exported.data).backupIncludesTextBodies, true);
    assert.equal(peak, 2);
  });

  it("round-trips 1000 Reader bookmarks through a portable backup", async () => {
    const current = createDefaultState();
    const books = Array.from({ length: 5 }, (_, index) => ({ id: `de-bookmarks-${index}`, title: `Book ${index}`, lang: "de" }));
    current.profiles.de.customTexts = books;
    current.customTexts = books;
    current.preferences.readerBookmarks = Object.fromEntries(books.map((book, bookIndex) => [
      book.id,
      Array.from({ length: 200 }, (_, index) => ({
        id: `bookmark-${bookIndex}-${index}`,
        label: `Bookmark ${index}`,
        color: ["amber", "red", "green", "blue", "purple"][index % 5],
        page: Math.floor(index / 20) + 1,
        scrollTop: index * 17,
        wordIndex: index,
        createdAt: "2026-07-19T00:00:00Z"
      }))
    ]));
    replaceState(current, { save: false });
    for (const book of books) bookTexts.set(book.id, `Portable body for ${book.id}`);
    let exported = null;
    globalThis.fetch = async (url, options) => {
      if (url === "/__export/save") {
        exported = JSON.parse(options.body);
        return { ok: true, json: async () => ({ saved: true }) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    await exportState();

    const portable = JSON.parse(exported.data);
    assert.equal(Object.values(portable.preferences.readerBookmarks).reduce((total, items) => total + items.length, 0), 1000);
    replaceState(createDefaultState(), { save: false });
    globalThis.fetch = async (url, options) => {
      if (url === "/__store/save?snapshot=1") return { ok: true, json: async () => ({ snapshot: JSON.parse(options.body) }) };
      if (url === "/__store/save" || url === "/__store/ui_state" || url === "/__store/ack_snapshot") {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() { this.result = exported.data; this.onLoad(); }
    };
    importStateFile({ target: { files: [{ size: exported.data.length }], value: "bookmarks.json" } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(Object.values(state.preferences.readerBookmarks).reduce((total, items) => total + items.length, 0), 1000);
    assert.deepEqual(Object.values(state.preferences.readerBookmarks).map((items) => items.length), [200, 200, 200, 200, 200]);
    assert.deepEqual(new Set(state.preferences.readerBookmarks[books[0].id].map((bookmark) => bookmark.color)), new Set(["amber", "red", "green", "blue", "purple"]));
  });

  it("preserves a legacy text body stored only in the top-level custom-text list", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.customTexts = [{ id: "de-custom-legacy", title: "Legacy", lang: "de" }];
    imported.customTexts = [{
      id: "de-custom-legacy",
      title: "Legacy",
      lang: "de",
      text: "Legacy embedded body that must reach the profile record"
    }];
    replaceState(createDefaultState(), { save: false });
    let bookTextReads = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("/__book/text?id=")) {
        bookTextReads += 1;
        throw new Error("the embedded body should make this read unnecessary");
      }
      if (url === "/__store/save?snapshot=1") {
        const payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ snapshot: payload }) };
      }
      if (url === "/__store/ack_snapshot" || url === "/__store/save" || url === "/__store/ui_state") return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected URL: ${url}`);
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() {
        this.result = JSON.stringify(imported);
        this.onLoad();
      }
    };

    importStateFile({ target: { files: [{ size: 2048 }], value: "legacy.json" } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bookTextReads, 0);
    assert.equal(state.customTexts[0].text, "Legacy embedded body that must reach the profile record");
  });

  it("does not create empty book shells from an old metadata-only backup", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.customTexts = [{ id: "de-custom-empty", title: "Missing body", lang: "de" }];
    imported.customTexts = imported.profiles.de.customTexts;
    imported.preferences.readerBookmarks = {
      "de-custom-empty": [{ id: "orphan", label: "Orphan", page: 1, scrollTop: 0, wordIndex: 0, createdAt: "" }],
      "kept-book": [{ id: "kept", label: "Kept", page: 1, scrollTop: 0, wordIndex: 0, createdAt: "" }]
    };
    imported.preferences.lastReadTextIds = { de: "de-custom-empty" };
    imported.profiles.de.archivedBookIds = ["de-custom-empty", "kept-archive"];
    imported.archivedBookIds = imported.profiles.de.archivedBookIds;
    imported.currentTextId = "de-custom-empty";
    imported.currentView = "reader";
    imported.filters.vocabTextId = "de-custom-empty";
    imported.readerPages = { "de-custom-empty": 2 };
    imported.readerScrolls = { "de-custom-empty": { readerPage: 2, scrollTop: 90, wordIndex: 17 } };
    imported.readerScrollsPerPage = { "de-custom-empty-p2": 90 };
    replaceState(createDefaultState(), { save: false });
    let savedPayload = null;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("/__book/text?id=")) {
        return { ok: true, json: async () => ({ text: "" }) };
      }
      if (url === "/__store/save?snapshot=1") {
        savedPayload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ snapshot: savedPayload }) };
      }
      if (url === "/__store/ack_snapshot" || url === "/__store/save" || url === "/__store/ui_state") return { ok: true, json: async () => ({}) };
      throw new Error(`unexpected URL: ${url}`);
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() {
        this.result = JSON.stringify(imported);
        this.onLoad();
      }
    };

    importStateFile({ target: { files: [{ size: 1024 }], value: "old-backup.json" } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(savedPayload.texts, []);
    assert.deepEqual(state.customTexts, []);
    assert.equal(state.preferences.readerBookmarks["de-custom-empty"], undefined);
    assert.equal(state.preferences.readerBookmarks["kept-book"].length, 1);
    assert.equal(state.preferences.lastReadTextIds.de, undefined);
    assert.deepEqual(state.archivedBookIds, ["kept-archive"]);
    assert.equal(state.currentTextId, null);
    assert.equal(state.currentView, "library");
    assert.equal(state.readerPage, 1);
    assert.equal(state.filters.vocabTextId, "all");
    assert.equal(state.readerPages["de-custom-empty"], undefined);
    assert.equal(state.readerScrolls["de-custom-empty"], undefined);
    assert.equal(state.readerScrollsPerPage["de-custom-empty-p2"], undefined);
  });

  it("still restores vocabulary when one legacy book body request fails", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.customTexts = [{ id: "de-custom-unavailable", title: "Unavailable", lang: "de" }];
    imported.customTexts = imported.profiles.de.customTexts;
    imported.profiles.de.vocab = { haus: { status: "known", translation: "house" } };
    imported.vocab = imported.profiles.de.vocab;
    replaceState(createDefaultState(), { save: false });
    let savedPayload = null;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("/__book/text?id=")) return { ok: false, status: 500 };
      if (url === "/__store/save?snapshot=1") {
        savedPayload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ snapshot: savedPayload }) };
      }
      if (url === "/__store/ack_snapshot" || url === "/__store/save" || url === "/__store/ui_state") {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() { this.result = JSON.stringify(imported); this.onLoad(); }
    };
    const previousWarn = console.warn;
    console.warn = () => {};
    try {
      importStateFile({ target: { files: [{ size: 1024 }], value: "legacy.json" } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.warn = previousWarn;
    }

    assert.equal(savedPayload.vocab.de.vocab.haus.translation, "house");
    assert.deepEqual(savedPayload.texts, []);
    assert.equal(state.vocab.haus.status, "known");
    assert.deepEqual(state.customTexts, []);
  });

  it("falls back to readable text when new or legacy PDF backups have no page images", async () => {
    for (const includesMediaMarker of [false, undefined, true]) {
      const imported = createDefaultState();
      imported.schemaVersion = STATE_SCHEMA_VERSION;
      if (includesMediaMarker !== undefined) imported.backupIncludesMediaFiles = includesMediaMarker;
      imported.profiles.de.customTexts = [{
        id: "de-custom-pdf",
        title: "Portable PDF",
        lang: "de",
        text: "Lesbarer wiederhergestellter Text\n[IMG:page-1.png]\nEnde",
        coverDataUrl: "/__media?book=de-custom-pdf&img=page-1.png",
        pdfOcrPages: [{ imageName: "page-1.png", text: "Lesbarer wiederhergestellter Text" }]
      }];
      imported.customTexts = imported.profiles.de.customTexts;
      replaceState(createDefaultState(), { save: false });
      globalThis.fetch = async (url, options) => {
        if (url === "/__store/save?snapshot=1") {
          const payload = JSON.parse(options.body);
          return { ok: true, json: async () => ({ snapshot: payload }) };
        }
        if (url === "/__store/ack_snapshot" || url === "/__store/save" || url === "/__store/ui_state") return { ok: true, json: async () => ({}) };
        throw new Error(`unexpected URL: ${url}`);
      };
      globalThis.FileReader = class FileReader {
        addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
        readAsText() {
          this.result = JSON.stringify(imported);
          this.onLoad();
        }
      };

      importStateFile({ target: { files: [{ size: 2048 }], value: "portable-pdf.json" } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(state.customTexts[0].text, "Lesbarer wiederhergestellter Text\nEnde");
      assert.equal(state.customTexts[0].pdfOcrPages, undefined);
      assert.equal(state.customTexts[0].coverDataUrl, "");
    }
  });

  it("imports a 16 MiB native backup and clears cached user-book bodies", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.userBooks = [{ id: "same-user-book", title: "Imported", textUrl: "/imported-body" }];
    imported.profiles.de.vocab = { haus: { status: "known", translation: "house" } };
    imported.userBooks = imported.profiles.de.userBooks;
    imported.vocab = imported.profiles.de.vocab;
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
      if (url === "/__store/ack_snapshot" || url === "/__store/ui_state") return { ok: true, json: async () => ({}) };
      return { ok: true, text: async () => `${url} ${"word ".repeat(50)}` };
    };
    globalThis.FileReader = class FileReader {
      addEventListener(type, listener) { if (type === "load") this.onLoad = listener; }
      readAsText() {
        this.result = JSON.stringify(imported);
        this.onLoad();
      }
    };

    importStateFile({ target: { files: [{ size: 16 * 1024 * 1024 }], value: "backup.json" } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(bookTexts.get("same-user-book"), /^\/imported-body/);
    assert.equal(state.userBooks[0].title, "Imported");
    assert.equal(state.vocab.haus.status, "known");
  });

  it("keeps a successful durable import when the first UI-state write needs a retry", async () => {
    const imported = createDefaultState();
    imported.schemaVersion = STATE_SCHEMA_VERSION;
    imported.profiles.de.vocab = { neu: { status: "known" } };
    imported.vocab = imported.profiles.de.vocab;
    replaceState(createDefaultState(), { save: false });
    let uiSaveAttempts = 0;
    globalThis.fetch = async (url, options) => {
      if (url === "/__store/save?snapshot=1") {
        return { ok: true, json: async () => ({ snapshot: JSON.parse(options.body) }) };
      }
      if (url === "/__store/ui_state") {
        uiSaveAttempts += 1;
        return uiSaveAttempts === 1
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, json: async () => ({}) };
      }
      if (url === "/__store/ack_snapshot" || url === "/__store/save") {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected URL: ${url}`);
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
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.warn = previousWarn;
    }

    assert.equal(state.vocab.neu.status, "known");
    assert.equal(uiSaveAttempts, 2);
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
      if (url === "/__store/load?ack=0") return { ok: true, json: async () => currentSnapshot };
      if (url === "/__store/ack_snapshot") return { ok: true, json: async () => ({}) };
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
