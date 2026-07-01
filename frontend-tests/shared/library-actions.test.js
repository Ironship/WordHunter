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

const { createDefaultState, replaceState, state } = await import("../../src/web/js/state.js");
const {
  archiveBookId,
  clearCurrentBookSelectionIfMatches,
  ensureActiveLibraryCollections,
  forgetArchivedBook,
  moveCustomTextToProfile,
  moveUserBookToProfile,
  removeCustomTextFromActiveProfile
} = await import("../../src/web/js/book-actions/profile-library.js");

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

    const moved = moveCustomTextToProfile("de-custom-home", "fr");

    assert.equal(moved.oldId, "de-custom-home");
    assert.equal(moved.newId, "fr-custom-home");
    assert.deepEqual(state.customTexts, []);
    assert.deepEqual(state.archivedBookIds, []);
    assert.equal(state.profiles.fr.customTexts[0].id, "fr-custom-home");
    assert.equal(state.profiles.fr.customTexts[0].title, "Home");
    assert.match(state.profiles.fr.customTexts[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
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
});
