// A Gutenberg book added from Discover caches its full text as the custom
// text gutenberg-full-{lang}-{id} (or the older gutenberg-full-{id}) the first
// time it is read. The Library must keep showing one card for the book, and
// removing the book must take that cached copy with it.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

globalThis.window = { __qtBridge: false, addEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const profileLibrary = await import("../../dist/web/js/book-actions/profile-library.js");

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

async function evaluateWithMocks(file, importValues, globals = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  const modules = new Map();
  for (const [specifier, values] of Object.entries(importValues)) {
    modules.set(specifier, new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context, identifier: `mock:${specifier}` }
    ));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier} from ${file}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(read(file), {
    context,
    identifier: new URL(`../../${file}`, import.meta.url).href,
    importModuleDynamically: async (specifier) => {
      const dependency = getModule(specifier);
      if (dependency.status === "unlinked") await dependency.link(() => {});
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    }
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

const pride = { id: "user-1342", gutenbergId: "1342", title: "Pride and Prejudice", author: "Jane Austen" };
const frankenstein = { id: "user-84", gutenbergId: "84", title: "Frankenstein", author: "Mary Shelley" };

function resetProfiles() {
  const defaults = createDefaultState();
  const de = {
    vocab: {},
    userBooks: [{ ...pride }, { ...frankenstein }],
    customTexts: [
      { id: "gutenberg-full-de-1342", title: "Pride and Prejudice (full text)", text: "..." },
      { id: "gutenberg-full-84", title: "Frankenstein (full text)", text: "..." },
      { id: "gutenberg-full-de-2701", title: "Moby Dick (full text)", text: "..." },
      { id: "de-custom-notes", title: "Notes", text: "..." }
    ],
    hiddenBuiltInBooks: [],
    archivedBookIds: []
  };
  // The pre-profile id is shared with another profile's copy.
  const fr = { vocab: {}, userBooks: [], customTexts: [{ id: "gutenberg-full-84", title: "Frankenstein (full text)" }], hiddenBuiltInBooks: [], archivedBookIds: [] };
  replaceState({
    ...defaults,
    preferences: { ...defaults.preferences, learningLanguage: "de" },
    profiles: { de, fr },
    vocab: de.vocab,
    customTexts: de.customTexts,
    userBooks: de.userBooks,
    hiddenBuiltInBooks: de.hiddenBuiltInBooks,
    archivedBookIds: de.archivedBookIds,
    currentTextId: "gutenberg-full-de-1342",
    readerPages: { "gutenberg-full-de-1342": 7 }
  }, { save: false });
}

async function renderedLibraryCardIds() {
  const bookList = { innerHTML: "", querySelectorAll: () => [] };
  const libraryElements = {
    "book-list": bookList,
    "library-search": { value: "" },
    "level-filter": { value: "" },
    "library-sort": { value: "" },
    "library-archive-filter": { value: "" },
    "library-sort-reverse": { dataset: {} }
  };
  const viewState = {
    currentView: "library",
    filters: { libraryQuery: "", libraryLevel: "all", librarySort: "title", librarySortReverse: false, libraryArchive: "active" },
    preferences: { learningLanguage: "de", wordDetectionAlgorithm: "modern", showCardStats: false, showCovers: false },
    vocab: {},
    customTexts: state.customTexts,
    userBooks: state.userBooks,
    archivedBookIds: []
  };
  const { renderLibrary } = await evaluateWithMocks("dist/web/js/views/library.js", {
    "../state.js": { state: viewState, saveUiState() {} },
    "../utils.js": {
      escapeHtml: String,
      escapeAttribute: String,
      parseTagList: () => [],
      calcRoundedStatsPcts: () => ({ knownPct: 0, learningPct: 0, newPct: 0 }),
      calcStatsPcts: () => ({ knownPct: 0, learningPct: 0, newPct: 0 })
    },
    "../icons.js": { icon: () => "", renderCardStat: () => "", renderCardCount: () => "" },
    "../tokenizer_v2.js": { normalizeSearchVariants: (value) => [String(value).toLowerCase()] },
    "../books.js": {
      findBookById: () => null,
      getAllBooks: () => viewState.userBooks,
      bookTexts: { has: () => false, get: () => undefined, peek: () => undefined, fingerprint: () => "" },
      hydrateActiveLibraryTexts: async () => {},
      getLibraryContentGeneration: () => 0,
      isBookTextCacheStale: () => false,
      loadBookText: async () => "",
      loadCustomTextContent: async () => ""
    },
    "../book-actions/profile-library.js": { gutenbergFullTextIds: profileLibrary.gutenbergFullTextIds },
    "../stats-cache.js": {
      getCachedBookTextStats: () => null,
      getCachedTextStats: () => null,
      prepareTextStats: () => ""
    },
    "../i18n.js": { t: (key) => key, getLocale: () => "en" },
    "../panel-resizer.js": { bindSidebarResizer() {} },
    "../platform.js": { openAndroidUrl: () => false },
    "../toast.js": { showToast: () => {} },
    "../loading.js": { beginElementBusy: () => () => {} },
    "../translator-preferences.js": { effectiveLearningLanguage: () => "de" }
  }, {
    window: {},
    document: {
      getElementById(id) { return libraryElements[id] ?? null; },
      querySelector() { return null; }
    },
    requestAnimationFrame: () => 1,
    Intl
  });
  renderLibrary();
  return [...bookList.innerHTML.matchAll(/data-book-id="([^"]+)"/g)].map((match) => match[1]).sort();
}

async function libraryOps(calls) {
  return evaluateWithMocks("dist/web/js/book-actions/library-ops.js", {
    "../state.js": {
      state,
      async saveState() { calls.push("save"); },
      clearLastReadTextId() {}
    },
    "../toast.js": { showToast() {} },
    "../render.js": { render() {}, ensureCurrentText() {} },
    "../views/library.js": { renderLibrary() {} },
    "../books.js": {
      bookTexts: new Map(),
      clearBookTextCache(id) { calls.push(`clear:${id}`); },
      async loadCustomTextContent() { return ""; }
    },
    "../vocab-index-client.js": { invalidateBookId() {} },
    "../i18n.js": { t: (key) => key },
    "../bridge-commit.js": { async reloadBridgeSnapshot() { return false; }, async saveStateAndReloadBridge() {} },
    "../store-bridge.js": {
      async upsertStoredText() {},
      async deleteStoredText(id) { calls.push(`delete:${id}`); }
    },
    "./profile-library.js": { ...profileLibrary }
  }, { window: { __qtBridge: true } });
}

describe("Gutenberg full-text cache in the Library", () => {
  beforeEach(resetProfiles);

  it("shows one card per Gutenberg book while its user book exists", async () => {
    assert.deepEqual(await renderedLibraryCardIds(), [
      "de-custom-notes",
      "gutenberg-full-de-2701",
      "user-1342",
      "user-84"
    ]);
  });

  it("removes the cached full text together with the user book", async () => {
    const calls = [];
    const { removeUserBook } = await libraryOps(calls);

    await removeUserBook("user-1342");

    assert.deepEqual(state.userBooks.map((book) => book.id), ["user-84"]);
    assert.deepEqual(state.customTexts.map((text) => text.id), ["gutenberg-full-84", "gutenberg-full-de-2701", "de-custom-notes"]);
    assert.equal(state.currentTextId, null);
    assert.equal(state.readerPages["gutenberg-full-de-1342"], undefined);
    assert.deepEqual(calls, ["clear:user-1342", "clear:gutenberg-full-de-1342", "save", "delete:gutenberg-full-de-1342"]);
    assert.deepEqual(await renderedLibraryCardIds(), ["de-custom-notes", "gutenberg-full-de-2701", "user-84"]);
  });

  it("keeps the store body of a legacy full text another profile still lists", async () => {
    const calls = [];
    const { removeUserBook } = await libraryOps(calls);

    await removeUserBook("user-84");

    assert.deepEqual(state.customTexts.map((text) => text.id), ["gutenberg-full-de-1342", "gutenberg-full-de-2701", "de-custom-notes"]);
    assert.deepEqual(state.profiles.fr.customTexts.map((text) => text.id), ["gutenberg-full-84"]);
    assert.deepEqual(calls, ["clear:user-84", "clear:gutenberg-full-84", "save"]);
  });

  it("leaves the cached full text behind in neither profile when a user book moves", async () => {
    const calls = [];
    const { moveBookToProfile } = await libraryOps(calls);
    state.preferences.readerBookmarks = { "gutenberg-full-de-1342": [{ id: "b1", page: 40 }] };
    state.readerPages = { "gutenberg-full-de-1342": 40 };

    assert.equal(await moveBookToProfile("user-1342", "fr", false), true);

    // The book fetches its full text again under the French id and finds
    // where the reader was.
    assert.deepEqual(state.preferences.readerBookmarks["gutenberg-full-fr-1342"], [{ id: "b1", page: 40 }]);
    assert.equal(state.readerPages["gutenberg-full-fr-1342"], 40);

    assert.deepEqual(state.userBooks.map((book) => book.id), ["user-84"]);
    assert.ok(state.profiles.fr.userBooks.some((book) => book.id === "user-1342"));
    assert.ok(!state.customTexts.some((text) => text.id === "gutenberg-full-de-1342"));
    assert.ok(!state.profiles.fr.customTexts.some((text) => text.id === "gutenberg-full-de-1342"));
    assert.ok(calls.includes("delete:gutenberg-full-de-1342"), calls.join(", "));
  });
});
