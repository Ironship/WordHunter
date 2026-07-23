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

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { bookTexts, clearAllBookTextCaches, hydrateActiveLibraryTexts, hydrateCurrentReaderText, loadAllBookTexts, loadAllCustomTextContents, loadBooksCatalog } = await import("../../dist/web/js/books.js");
const { els } = await import("../../dist/web/js/dom.js");
const { loadFullGutenbergText, openBook } = await import("../../dist/web/js/book-actions.js");
const { getReaderBookmarks } = await import("../../dist/web/js/reader/bookmarks.js");
const { setView } = await import("../../dist/web/js/render.js");

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
  const catalog = JSON.parse(readFileSync(new URL("../../dist/web/books/index.json", import.meta.url), "utf8"));
  const languages = ["en", "de", "es", "fr", "it", "pl", "uk", "ru", "ja", "zh", "la", "grc"];

  it("ships one original common-word story per language", () => {
    const stories = catalog.filter((book) => book.id.endsWith("-common-stories"));
    const expectedIds = languages.map((lang) => `starter-${lang}-common-stories`);

    assert.deepEqual(stories.map((book) => book.id).sort(), expectedIds.sort());

    for (const book of stories) {
      assert.equal(book.author, "Word Hunter Originals");
      assert.equal(book.source, "Word Hunter Originals");
      assert.ok(book.title);
      assert.ok(book.blurb);
      assert.equal(book.localPath, `books/starter/${book.lang}-stories.txt`);
      assert.equal(book.textUrl, undefined);
      assert.equal(book.coverPath, `books/starter/${book.lang}-cover.svg`);

      const text = readFileSync(new URL(`../../dist/web/${book.localPath}`, import.meta.url), "utf8");
      const cover = readFileSync(new URL(`../../dist/web/${book.coverPath}`, import.meta.url), "utf8");
      const words = [...new Intl.Segmenter(book.lang, { granularity: "word" }).segment(text)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment.toLocaleLowerCase(book.lang));

      assert.ok(text.length >= 20_000, `${book.lang} starter text is unexpectedly short`);
      assert.ok(new Set(words).size >= 1_000, `${book.lang} starter text has fewer than 1,000 distinct word segments`);
      assert.match(cover, /^<svg\b/);
      assert.match(cover, /<title\b/);
    }
  });

  it("ships one A1-B2 course and cover per language", () => {
    const levels = ["A1", "A2", "B1", "B2"];
    const courses = catalog.filter((book) => levels.includes(book.level));
    const expectedIds = languages.flatMap((lang) => levels.map((level) => `starter-${lang}-${level.toLowerCase()}-course`));

    assert.deepEqual(courses.map((book) => book.id).sort(), expectedIds.sort());
    assert.equal(new Set(courses.map((book) => book.localPath)).size, courses.length);
    assert.equal(new Set(courses.map((book) => book.coverPath)).size, courses.length);

    for (const course of courses) {
      const slug = course.level.toLowerCase();
      assert.equal(course.author, "Word Hunter Originals");
      assert.equal(course.source, "Word Hunter Originals");
      assert.ok(course.title);
      assert.ok(course.blurb);
      assert.equal(course.localPath, `books/starter/${course.lang}-${slug}-course.txt`);
      assert.equal(course.textUrl, undefined);
      assert.equal(course.coverPath, `books/starter/${course.lang}-${slug}-course-cover.svg`);

      const text = readFileSync(new URL(`../../dist/web/${course.localPath}`, import.meta.url), "utf8");
      const cover = readFileSync(new URL(`../../dist/web/${course.coverPath}`, import.meta.url), "utf8");
      const openingLines = text.split(/\r?\n/).slice(0, 5);

      assert.ok(text.length >= 12_000, `${course.lang} ${course.level} course is unexpectedly short`);
      assert.equal(openingLines[0], course.title, `${course.lang} ${course.level} course must start with its catalog title`);
      assert.ok(openingLines.includes("Word Hunter Originals"), `${course.lang} ${course.level} course must put its attribution after the title`);
      assert.match(cover, /^<svg\b/);
      assert.match(cover, /<title\b/);
      assert.match(cover, /<desc\b/);
      assert.match(cover, /\bviewBox=["']0\s+0\s+600\s+900["']/);
    }
  });
});

describe("full-text hydration", () => {
  it("hydrates the active Reader body before its saved page can be clamped", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      currentView: "reader",
      currentTextId: "de-custom-resume",
      readerPages: { "de-custom-resume": 5 },
      preferences: {
        ...createDefaultState().preferences,
        wordDetectionAlgorithm: "classic",
        readerBookmarks: {
          "de-custom-resume": [{
            id: "mark-1",
            label: "Compound",
            page: 1,
            scrollTop: 0,
            wordIndex: 4,
            anchorOffset: 18,
            anchorWord: "art",
            wordAlgorithm: "modern",
            createdAt: "2026-07-18T00:00:00Z"
          }]
        }
      },
      customTexts: [{ id: "de-custom-resume", title: "Resume", lang: "de", text: "" }]
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    globalThis.fetch = async (url) => String(url).startsWith("/__book/text")
      ? { ok: true, json: async () => ({ text: `zero state-of-the-art one ${"Wort ".repeat(6000)}` }) }
      : { ok: true, json: async () => ({}) };

    assert.equal(await hydrateCurrentReaderText(), true);

    assert.match(bookTexts.get("de-custom-resume"), /^zero state-of-the-art one/);
    assert.equal(state.readerPages["de-custom-resume"], 5);
    assert.equal(getReaderBookmarks("de-custom-resume")[0].wordIndex, 1);
    assert.equal(state.preferences.readerBookmarks["de-custom-resume"][0].wordIndex, 4);
    assert.equal(state.preferences.readerBookmarks["de-custom-resume"][0].wordAlgorithm, "modern");
    clearAllBookTextCaches();
  });

  it("hydrates deferred PDF page metadata only for the active Reader", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      currentView: "reader",
      currentTextId: "de-pdf-resume",
      customTexts: [{
        id: "de-pdf-resume",
        title: "PDF",
        lang: "de",
        pdfOcrPageCount: 1
      }]
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        json: async () => ({ pages: [{ imageName: "page-1.png", text: "Seite" }] })
      };
    };

    assert.equal(await hydrateCurrentReaderText(), true);
    assert.deepEqual(state.customTexts[0].pdfOcrPages, [{
      imageName: "page-1.png",
      text: "Seite"
    }]);
    assert.deepEqual(requests, ["/__book/pdf_pages?id=de-pdf-resume"]);
    assert.equal(bookTexts.has("de-pdf-resume"), false);
    clearAllBookTextCaches();
  });

  it("opens a deferred PDF without fetching its duplicate text body", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      currentView: "library",
      customTexts: [{
        id: "de-pdf-open",
        title: "PDF",
        lang: "de",
        pdfOcrPageCount: 1
      }]
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    bookTexts.set("de-pdf-open", "duplicate OCR body");
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        json: async () => ({ pages: [{ imageName: "page-1.png", text: "Seite" }] })
      };
    };

    assert.equal(await openBook("de-pdf-open"), true);
    assert.equal(state.currentView, "reader");
    assert.deepEqual(requests, ["/__book/pdf_pages?id=de-pdf-open"]);
    assert.equal(bookTexts.get("de-pdf-open"), "duplicate OCR body");
    clearAllBookTextCaches();
  });

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

  it("does not open an empty custom text returned by the backend", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      customTexts: [{ id: "de-custom-empty", title: "Missing body", lang: "de" }],
      currentView: "library",
      currentTextId: null
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "" }) });

    assert.equal(await openBook("de-custom-empty"), false);
    assert.equal(state.currentView, "library");
    assert.equal(state.currentTextId, null);
    assert.equal(bookTexts.has("de-custom-empty"), false);
  });

  it("keeps the last committed selection when a second concurrent open fails", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    replaceState({
      ...createDefaultState(),
      customTexts: [
        { id: "de-custom-slow", title: "Slow", lang: "de" },
        { id: "de-custom-empty", title: "Empty", lang: "de" }
      ],
      currentView: "library",
      currentTextId: null
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    let resolveSlow;
    globalThis.fetch = (url) => String(url).includes("de-custom-slow")
      ? new Promise((resolve) => { resolveSlow = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ text: "" }) });

    const slowOpening = openBook("de-custom-slow");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await openBook("de-custom-empty"), false);
    resolveSlow({ ok: true, json: async () => ({ text: "slow body" }) });
    assert.equal(await slowOpening, false);

    assert.equal(state.currentView, "library");
    assert.equal(state.currentTextId, null);
  });

  it("stores downloaded Gutenberg full text under the active profile namespace", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = false;
    replaceState(createDefaultState(), { save: false });
    state.preferences.learningLanguage = "de";
    const body = "A sufficiently long Gutenberg body. ".repeat(40);
    globalThis.fetch = async () => ({ ok: true, text: async () => body });

    await loadFullGutenbergText({
      id: "user-123",
      gutenbergId: "123",
      title: "Book",
      author: "Author",
      textUrl: "https://example.test/123.txt",
      pageUrl: "https://example.test/123"
    });

    assert.ok(state.customTexts.some((text) => text.id === "gutenberg-full-de-123"));
    assert.equal(state.customTexts.some((text) => text.id === "gutenberg-full-123"), false);
  });

  it("does not open a catalog book when all text sources fail", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = false;
    replaceState({
      ...createDefaultState(),
      userBooks: [{ id: "user-offline", title: "Offline", textUrl: "https://example.invalid/book.txt" }],
      currentView: "library",
      currentTextId: null
    }, { save: false });
    state.profiles.de.userBooks = state.userBooks;
    globalThis.fetch = async () => ({ ok: false, status: 503 });

    assert.equal(await openBook("user-offline"), false);
    assert.equal(state.currentView, "library");
    assert.equal(state.currentTextId, null);
    assert.equal(bookTexts.has("user-offline"), false);
  });

  it("clears the previous book selection before opening another book", async () => {
    window.__qtBridge = false;
    replaceState({
      ...createDefaultState(),
      customTexts: [{ id: "de-custom-next", title: "Next", lang: "de", text: "neuer Text" }],
      currentView: "library",
      selectedWord: "alt",
      selectedWordIndex: 777,
      readerSelectionRange: { anchor: 2, focus: 4 }
    }, { save: false });
    window.lastActiveToken = { dataset: { wordIndex: "777" } };

    assert.equal(await openBook("de-custom-next"), true);
    assert.equal(state.selectedWord, null);
    assert.equal(state.selectedWordIndex, null);
    assert.equal(state.readerSelectionRange, null);
    assert.equal(window.lastActiveToken, null);
  });

  it("removes the Reader loading placeholder after a failed open", async () => {
    clearAllBookTextCaches();
    window.__qtBridge = true;
    const attributes = new Set();
    els.readerText = {
      dataset: {},
      style: {},
      classList: { remove() {}, toggle() {} },
      innerHTML: "",
      setAttribute(name) { attributes.add(name); },
      removeAttribute(name) { attributes.delete(name); }
    };
    els.textSelect = { innerHTML: "" };
    els.readerHeading = { textContent: "" };
    els.readerSource = { textContent: "" };
    replaceState({
      ...createDefaultState(),
      customTexts: [{ id: "de-custom-empty-reader", title: "Missing", lang: "de" }],
      currentView: "reader",
      currentTextId: null
    }, { save: false });
    state.profiles.de.customTexts = state.customTexts;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "" }) });

    assert.equal(await openBook("de-custom-empty-reader"), false);
    assert.equal(attributes.has("aria-busy"), false);
    assert.doesNotMatch(els.readerText.innerHTML, /reader-loading/);
  });
});
