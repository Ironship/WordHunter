import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = {
  body: { contains() { return false; } },
  documentElement: {
    dataset: { platform: "desktop" },
    classList: { toggle() {}, remove() {} },
    style: { setProperty() {} }
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  addEventListener() {}
};

const { createDefaultState, replaceState, state } = await import("../../src/web/js/state.js");
const { bookTexts, clearAllBookTextCaches, hydrateActiveLibraryTexts, loadAllBookTexts, loadAllCustomTextContents, loadBooksCatalog } = await import("../../src/web/js/books.js");
const { els } = await import("../../src/web/js/dom.js");
const { openBook } = await import("../../src/web/js/book-actions.js");
const { setView } = await import("../../src/web/js/render.js");

Object.assign(els, {
  navItems: [],
  views: [],
  pageTitle: {},
  overallCount: {},
  pillKnown: {},
  pillLearning: {},
  pillNew: {}
});

describe("built-in starter catalog", () => {
  it("ships one original text and cover with at least 1,000 word segments per language", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../src/web/books/index.json", import.meta.url), "utf8"));
    const languages = ["en", "de", "es", "fr", "it", "pl", "uk", "ru", "ja", "zh", "la", "grc"];

    assert.equal(catalog.length, languages.length);
    assert.deepEqual([...new Set(catalog.map((book) => book.lang))].sort(), [...languages].sort());
    assert.equal(new Set(catalog.map((book) => book.id)).size, catalog.length);

    for (const book of catalog) {
      assert.equal(book.author, "Word Hunter Originals");
      assert.equal(book.source, "Word Hunter Originals");
      assert.ok(book.title);
      assert.ok(book.blurb);
      assert.equal(book.localPath, `books/starter/${book.lang}-stories.txt`);
      assert.equal(book.textUrl, undefined);
      assert.equal(book.coverPath, `books/starter/${book.lang}-cover.svg`);

      const text = readFileSync(new URL(`../../src/web/${book.localPath}`, import.meta.url), "utf8");
      const cover = readFileSync(new URL(`../../src/web/${book.coverPath}`, import.meta.url), "utf8");
      const words = [...new Intl.Segmenter(book.lang, { granularity: "word" }).segment(text)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment.toLocaleLowerCase(book.lang));

      assert.ok(text.length >= 20_000, `${book.lang} starter text is unexpectedly short`);
      assert.ok(new Set(words).size >= 1_000, `${book.lang} starter text has fewer than 1,000 distinct word segments`);
      assert.match(cover, /^<svg\b/);
      assert.match(cover, /<title\b/);
    }
  });
});

describe("full-text hydration", () => {
  it("loads every book while keeping at most two text fetches active", async () => {
    state.preferences.learningLanguage = "en";
    let active = 0;
    let peak = 0;
    globalThis.fetch = async (url) => {
      if (url === "books/index.json") {
        return { ok: true, json: async () => ["one", "two", "three"].map((id) => ({ id, lang: "en", textUrl: `/${id}` })) };
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, text: async () => `${url} ${"word ".repeat(50)}` };
    };

    await loadBooksCatalog();
    await loadAllBookTexts();

    assert.equal(peak, 2);
    assert.deepEqual([...bookTexts.keys()].sort(), ["one", "three", "two"]);
  });

  it("loads every custom text while keeping at most two record requests active", async () => {
    window.__qtBridge = true;
    state.customTexts = Array.from({ length: 8 }, (_, index) => ({ id: `custom-${index}` }));
    let active = 0;
    let peak = 0;
    globalThis.fetch = async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const id = new URL(url, "http://localhost").searchParams.get("id");
      return { ok: true, json: async () => ({ text: `body:${id}` }) };
    };

    await loadAllCustomTextContents();

    assert.equal(peak, 2);
    for (const text of state.customTexts) assert.equal(bookTexts.get(text.id), `body:${text.id}`);
  });

  it("hydrates the selected profile after an older profile batch finishes", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = false;
    state.customTexts = [];
    state.preferences.learningLanguage = "en";
    let resolveEnglish;
    globalThis.fetch = async (url) => {
      if (url === "books/index.json") {
        return {
          ok: true,
          json: async () => [
            { id: "en-book", lang: "en", textUrl: "/en" },
            { id: "de-book", lang: "de", textUrl: "/de" }
          ]
        };
      }
      if (url === "/en") return new Promise((resolve) => { resolveEnglish = resolve; });
      if (url === "/de") return { ok: true, text: async () => "deutscher Text ".repeat(50) };
      throw new Error(`unexpected URL: ${url}`);
    };
    await loadBooksCatalog();
    const englishBatch = loadAllBookTexts();
    await new Promise((resolve) => setImmediate(resolve));
    state.preferences.learningLanguage = "de";
    const germanBatch = hydrateActiveLibraryTexts();
    resolveEnglish({ ok: true, text: async () => "English text ".repeat(50) });

    await englishBatch;
    assert.equal(await germanBatch, true);
    assert.equal(bookTexts.get("de-book"), "deutscher Text ".repeat(50).trim());
  });

  it("does not resume an old hydration batch after all text caches are cleared", async () => {
    window.__qtBridge = true;
    state.customTexts = Array.from({ length: 4 }, (_, index) => ({ id: `stale-${index}` }));
    const responses = [];
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return new Promise((resolve) => responses.push(resolve));
    };

    const hydration = loadAllCustomTextContents();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    clearAllBookTextCaches();
    for (const resolve of responses) resolve({ ok: true, json: async () => ({ text: "stale body" }) });
    await hydration;

    assert.equal(requests, 2);
    for (const text of state.customTexts) assert.equal(bookTexts.has(text.id), false);
  });

  it("does not switch back to Reader when an async book open finishes late", async () => {
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      customTexts: [{ id: "de-custom-slow", title: "Slow book", lang: "de" }],
      currentView: "library"
    }, { save: false });
    let resolveFetch;
    globalThis.fetch = (url) => String(url).startsWith("/__book/text")
      ? new Promise((resolve) => { resolveFetch = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({}) });

    const opening = openBook("de-custom-slow");
    await new Promise((resolve) => setImmediate(resolve));
    setView("help");
    resolveFetch({ ok: true, json: async () => ({ text: "slow body" }) });

    assert.equal(await opening, false);
    assert.equal(state.currentView, "help");
  });
});
