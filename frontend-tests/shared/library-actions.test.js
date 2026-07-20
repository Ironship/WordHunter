import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  addEventListener() {},
  dispatchEvent() {}
};

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { createDefaultState, replaceState, state, switchLearningLanguage } = await import("../../dist/web/js/state.js");
const {
  archiveBookId,
  clearCurrentBookSelectionIfMatches,
  ensureActiveLibraryCollections,
  forgetArchivedBook,
  isCustomTextReferenced,
  moveCustomTextToProfile,
  moveUserBookToProfile,
  removeCustomTextFromActiveProfile,
  removeUserBookFromActiveProfile
} = await import("../../dist/web/js/book-actions/profile-library.js");

function resetLibraryState() {
  const defaults = createDefaultState();
  const de = { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  const fr = { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  replaceState({
    ...defaults,
    preferences: { ...defaults.preferences, learningLanguage: "de" },
    profiles: { de, fr },
    vocab: de.vocab,
    customTexts: de.customTexts,
    userBooks: de.userBooks,
    hiddenBuiltInBooks: de.hiddenBuiltInBooks,
    archivedBookIds: de.archivedBookIds
  }, { save: false });
}

describe("profile library actions", () => {
  beforeEach(resetLibraryState);

  it("keeps active archive and hidden arrays wired to the active profile", () => {
    state.archivedBookIds = null;
    state.hiddenBuiltInBooks = "bad";

    ensureActiveLibraryCollections();

    assert.deepEqual(state.archivedBookIds, []);
    assert.deepEqual(state.hiddenBuiltInBooks, []);
    assert.strictEqual(state.profiles.de.archivedBookIds, state.archivedBookIds);
    assert.strictEqual(state.profiles.de.hiddenBuiltInBooks, state.hiddenBuiltInBooks);
  });

  it("archives without duplicates and unarchives in place", () => {
    archiveBookId("builtin-1");
    archiveBookId("builtin-1");

    assert.deepEqual(state.archivedBookIds, ["builtin-1"]);

    forgetArchivedBook("builtin-1");

    assert.deepEqual(state.archivedBookIds, []);
  });

  it("moves custom texts to the target profile and removes the old archive id", () => {
    state.customTexts.push({ id: "de-custom-home", title: "Home" });
    state.archivedBookIds.push("de-custom-home");
    state.readerPages["de-custom-home"] = 3;
    state.readerScrolls["de-custom-home"] = { scrollTop: 480, wordIndex: 96 };
    state.readerScrollsPerPage["de-custom-home-p3"] = 480;
    state.preferences.lastReadTextIds.de = "de-custom-home";

    const moved = moveCustomTextToProfile("de-custom-home", "fr");

    assert.equal(moved.oldId, "de-custom-home");
    assert.equal(moved.newId, "fr-custom-home");
    assert.deepEqual(state.customTexts, []);
    assert.deepEqual(state.archivedBookIds, []);
    assert.equal(state.profiles.fr.customTexts[0].id, "fr-custom-home");
    assert.equal(state.profiles.fr.customTexts[0].lang, "fr");
    assert.equal(state.profiles.fr.customTexts[0].title, "Home");
    assert.match(state.profiles.fr.customTexts[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.readerPages["fr-custom-home"], 3);
    assert.equal(state.readerPages["de-custom-home"], undefined);
    assert.deepEqual(state.readerScrolls["fr-custom-home"], { scrollTop: 480, wordIndex: 96 });
    assert.equal(state.readerScrolls["de-custom-home"], undefined);
    assert.equal(state.readerScrollsPerPage["fr-custom-home-p3"], 480);
    assert.equal(state.readerScrollsPerPage["de-custom-home-p3"], undefined);
    assert.equal(state.preferences.lastReadTextIds.fr, "fr-custom-home");
  });

  it("keeps old positions when a moved legacy id is still shared", () => {
    state.customTexts.push({ id: "legacy-home", title: "Home" });
    state.profiles.fr.customTexts.push({ id: "legacy-home", title: "Shared Home" });
    state.profiles.en = { vocab: {}, customTexts: [], userBooks: [] };
    state.readerPages["legacy-home"] = 2;
    state.readerScrolls["legacy-home"] = { scrollTop: 200 };
    state.readerScrollsPerPage["legacy-home-p2"] = 200;

    const moved = moveCustomTextToProfile("legacy-home", "en");

    assert.equal(moved.newId, "en-legacy-home");
    assert.equal(state.readerPages["legacy-home"], 2);
    assert.equal(state.readerPages["en-legacy-home"], 2);
    assert.deepEqual(state.readerScrolls["legacy-home"], { scrollTop: 200 });
    assert.deepEqual(state.readerScrolls["en-legacy-home"], { scrollTop: 200 });
    assert.equal(state.readerScrollsPerPage["legacy-home-p2"], 200);
    assert.equal(state.readerScrollsPerPage["en-legacy-home-p2"], 200);
  });

  it("moves three-letter custom text ids without colliding in the target profile", () => {
    state.customTexts.push({ id: "grc-custom-iliad", title: "Iliad", lang: "grc" });
    state.profiles.la = {
      vocab: {},
      customTexts: [{ id: "la-custom-iliad", title: "Existing" }],
      userBooks: [],
      hiddenBuiltInBooks: [],
      archivedBookIds: []
    };

    const moved = moveCustomTextToProfile("grc-custom-iliad", "la");

    assert.equal(moved.oldId, "grc-custom-iliad");
    assert.equal(moved.newId, "la-custom-iliad-2");
    assert.equal(moved.textObj.lang, "la");
    assert.deepEqual(state.profiles.la.customTexts.map((text) => text.id), ["la-custom-iliad", "la-custom-iliad-2"]);
  });

  it("moves user books to the target profile and removes the old archive id", () => {
    state.userBooks.push({ id: "user-1", title: "User book" });
    state.archivedBookIds.push("user-1");

    const moved = moveUserBookToProfile("user-1", "fr");

    assert.equal(moved.id, "user-1");
    assert.deepEqual(state.userBooks, []);
    assert.deepEqual(state.archivedBookIds, []);
    assert.deepEqual(state.profiles.fr.userBooks, [{ id: "user-1", title: "User book" }]);
  });

  it("removes custom texts and clears the current selection only on matching ids", () => {
    state.customTexts.push({ id: "de-custom-old", title: "Old" });
    state.archivedBookIds.push("de-custom-old");
    state.currentTextId = "de-custom-old";
    state.selectedWord = "word";

    const removed = removeCustomTextFromActiveProfile("de-custom-old");

    assert.equal(removed.id, "de-custom-old");
    assert.deepEqual(state.customTexts, []);
    assert.deepEqual(state.archivedBookIds, []);
    assert.equal(clearCurrentBookSelectionIfMatches("other"), false);
    assert.equal(state.currentTextId, "de-custom-old");
    assert.equal(clearCurrentBookSelectionIfMatches("de-custom-old"), true);
    assert.equal(state.currentTextId, null);
    assert.equal(state.selectedWord, null);
  });

  it("keeps shared-book bookmarks until the last profile reference is removed", () => {
    const shared = { id: "shared-book", title: "Shared" };
    state.userBooks.push(shared);
    state.profiles.fr.userBooks.push({ ...shared });
    state.preferences.readerBookmarks[shared.id] = [{ id: "mark-1", label: "Middle", page: 2 }];

    removeUserBookFromActiveProfile(shared.id);
    assert.equal(state.preferences.readerBookmarks[shared.id].length, 1);

    state.userBooks = state.profiles.fr.userBooks;
    state.profiles.fr.userBooks = state.userBooks;
    removeUserBookFromActiveProfile(shared.id);
    assert.equal(state.preferences.readerBookmarks[shared.id], undefined);
  });

  it("keeps a shared legacy custom-text body referenced by another profile", () => {
    const shared = { id: "mw-123", title: "Legacy shared text" };
    state.customTexts.push(shared);
    state.profiles.fr.customTexts.push({ ...shared });

    removeCustomTextFromActiveProfile(shared.id);

    assert.equal(isCustomTextReferenced(shared.id), true);
    assert.deepEqual(state.customTexts, []);
    assert.equal(state.profiles.fr.customTexts[0].id, shared.id);
  });

  it("keeps saved reader positions when switching away from and back to a profile", () => {
    state.readerPages = { "de-book": 7 };
    state.readerScrolls = { "de-book": { readerPage: 7, scrollTop: 420, wordIndex: 269 } };
    state.readerScrollsPerPage = { "de-book-p7": 420 };

    switchLearningLanguage("fr");
    switchLearningLanguage("de");

    assert.equal(state.readerPages["de-book"], 7);
    assert.deepEqual(state.readerScrolls["de-book"], { readerPage: 7, scrollTop: 420, wordIndex: 269 });
    assert.equal(state.readerScrollsPerPage["de-book-p7"], 420);
  });
});
