// Adding a Wikipedia/Wikinews result from Discover must import the article
// text from the wiki itself. Since 1.1.0 it was turned into a Gutenberg book
// whose download URL (…/epub/mw-wikipedia-de-4711/…) could never load.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const requests = [];
const extract = "Berlin ist die Hauptstadt der Bundesrepublik Deutschland.\n\nGeschichte\n\nDie Stadt wurde im 13. Jahrhundert gegründet.";

globalThis.window = { __qtBridge: false, addEventListener() {}, dispatchEvent() {} };
globalThis.document = {
  documentElement: { lang: "en", style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
class FakeElement {
  static [Symbol.hasInstance](value) { return value !== null && typeof value === "object"; }
}
globalThis.Element = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.HTMLDialogElement = FakeElement;
globalThis.HTMLTextAreaElement = FakeElement;
globalThis.fetch = window.fetch = async (url) => {
  requests.push(String(url));
  const pageId = new URL(String(url)).searchParams.get("pageids");
  return { ok: true, status: 200, json: async () => ({ batchcomplete: "", query: { pages: { [pageId]: { pageid: Number(pageId), title: "Berlin", extract } } } }) };
};

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { bookTexts } = await import("../../dist/web/js/books.js");
const { addUserBook, replaceLegacyMediaWikiBook } = await import("../../dist/web/js/book-actions/sources.js");
const { isMediaWikiArticleInLibrary } = await import("../../dist/web/js/discover/mediawiki.js");

function result(source, pageId = 4711) {
  const domain = source === "wikinews" ? "wikinews.org" : "wikipedia.org";
  return {
    id: `mw-${source}-de-${pageId}`,
    mwId: pageId,
    apiLang: "de",
    title: "Berlin",
    authors: [{ name: source }],
    languages: ["de"],
    summaries: ["Berlin ist die Hauptstadt..."],
    formats: {},
    source,
    domain,
    coverDataUrl: ""
  };
}

describe("Discover Wikipedia/Wikinews import", () => {
  beforeEach(() => {
    const defaults = createDefaultState();
    replaceState({ ...defaults, preferences: { ...defaults.preferences, learningLanguage: "de" } }, { save: false });
    requests.length = 0;
  });

  it("imports the article text from the wiki, not from Gutenberg", async () => {
    assert.equal(await addUserBook(result("wikipedia")), true);

    assert.equal(requests.length, 1);
    const url = new URL(requests[0]);
    assert.equal(url.host, "de.wikipedia.org");
    assert.equal(url.searchParams.get("pageids"), "4711");
    assert.equal(url.searchParams.get("explaintext"), "1");
    assert.ok(!requests.some((request) => request.includes("gutenberg")));

    assert.equal(state.userBooks.length, 0);
    const text = state.customTexts.find((entry) => entry.sourceUrl === "https://de.wikipedia.org/?curid=4711");
    assert.ok(text, "the article is a custom text of the active profile");
    assert.equal(text.id, "mw-de-wikipedia-de-4711");
    assert.equal(text.lang, "de");
    assert.equal(bookTexts.get(text.id), extract);
    assert.equal(isMediaWikiArticleInLibrary(result("wikipedia")), true);
  });

  it("does not import the same article twice", async () => {
    assert.equal(await addUserBook(result("wikipedia")), true);
    assert.equal(await addUserBook(result("wikipedia")), false);
    assert.equal(requests.length, 1);
    assert.equal(state.customTexts.length, 1);
  });

  it("does not file the article under a language chosen while it loads", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = window.fetch = async (url) => {
      state.preferences.learningLanguage = "fr";
      return previousFetch(url);
    };
    try {
      assert.equal(await addUserBook(result("wikipedia")), false);
    } finally {
      globalThis.fetch = window.fetch = previousFetch;
    }
    assert.equal(state.customTexts.length, 0);
  });

  it("replaces a wiki result that 1.1.0/1.1.1 saved as a Gutenberg book", async () => {
    const legacy = {
      id: "user-mw-wikipedia-de-4711",
      gutenbergId: "mw-wikipedia-de-4711",
      title: "Berlin",
      author: "Wikipedia",
      textUrl: "https://www.gutenberg.org/cache/epub/mw-wikipedia-de-4711/pgmw-wikipedia-de-4711.txt"
    };
    state.userBooks.push({ ...legacy });

    assert.equal(await replaceLegacyMediaWikiBook(legacy), "mw-de-wikipedia-de-4711");

    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).searchParams.get("pageids"), "4711");
    assert.equal(state.userBooks.length, 0);
    assert.ok(state.customTexts.some((entry) => entry.sourceUrl === "https://de.wikipedia.org/?curid=4711"));

    // Adding the result again from Discover also drops the broken entry.
    replaceState({ ...createDefaultState(), userBooks: [{ ...legacy }], preferences: { ...state.preferences } }, { save: false });
    assert.equal(await addUserBook(result("wikipedia")), true);
    assert.equal(state.userBooks.length, 0);
  });

  it("reads Wikinews articles from Wikinews", async () => {
    assert.equal(await addUserBook(result("wikinews", 99)), true);
    assert.equal(new URL(requests[0]).host, "de.wikinews.org");
    assert.ok(state.customTexts.some((entry) => entry.sourceUrl === "https://de.wikinews.org/?curid=99"));
  });
});

describe("Discover wiki editions", () => {
  it("knows which learning languages have no Wikipedia or Wikinews", async () => {
    const { mediaWikiEditionExists } = await import("../../dist/web/js/discover/mediawiki.js");
    assert.equal(mediaWikiEditionExists("wikipedia", "la"), true);
    assert.equal(mediaWikiEditionExists("wikipedia", "grc"), false);
    assert.equal(mediaWikiEditionExists("wikinews", "la"), false);
    assert.equal(mediaWikiEditionExists("wikinews", "de"), true);
  });

  it("lists search results in relevance order, not page-id order", async () => {
    const { searchMediaWiki } = await import("../../dist/web/js/discover/mediawiki.js");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = window.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ query: { pages: {
        "73119": { pageid: 73119, title: "Third", index: 3 },
        "3354": { pageid: 3354, title: "First", index: 1 },
        "999999": { pageid: 999999, title: "Second", index: 2 }
      } } })
    });
    try {
      const result = await searchMediaWiki("wikipedia", "de", "Berlin", 1, "", null, new AbortController().signal);
      assert.deepEqual(result.results.map((book) => book.title), ["First", "Second", "Third"]);
    } finally {
      globalThis.fetch = window.fetch = previousFetch;
    }
  });
});
