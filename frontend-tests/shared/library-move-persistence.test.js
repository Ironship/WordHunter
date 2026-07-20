import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

async function evaluateLibraryOps(importValues, globals) {
  const context = vm.createContext(globals);
  const modules = new Map(Object.entries(importValues).map(([specifier, values]) => [
    specifier,
    new vm.SyntheticModule(Object.keys(values), function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context, identifier: `mock:${specifier}` })
  ]));
  const source = new vm.SourceTextModule(
    readFileSync(new URL("../../dist/web/js/book-actions/library-ops.js", import.meta.url), "utf8"),
    { context, identifier: "library-ops-under-test" }
  );
  await source.link((specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier}`);
    return dependency;
  });
  await source.evaluate();
  return source.namespace;
}

async function runMove({ saveFails, sharedOldId, reloadSucceeds = true }) {
  const oldText = { id: "legacy-book", title: "Legacy", lang: "de" };
  const newText = { ...oldText, id: "fr-legacy-book", lang: "fr" };
  const deTexts = [oldText];
  const frTexts = [];
  const enTexts = sharedOldId ? [{ ...oldText, lang: "en" }] : [];
  const state = {
    preferences: { learningLanguage: "de" },
    profiles: {
      de: { customTexts: deTexts },
      fr: { customTexts: frTexts },
      en: { customTexts: enTexts }
    },
    customTexts: deTexts,
    currentTextId: oldText.id,
    selectedWord: "word",
    selectedWordIndex: 42,
    readerSelectionRange: { anchor: 1, focus: 2 },
    readerPage: 4,
    readerPages: { [oldText.id]: 4 },
    readerScrolls: { [oldText.id]: { scrollTop: 720, wordIndex: 42 } },
    readerScrollsPerPage: { [`${oldText.id}-p4`]: 720 }
  };
  state.preferences.lastReadTextIds = { de: oldText.id };
  const calls = [];
  const bookTexts = new Map([[oldText.id, "durable body"]]);
  const isReferenced = (id) => state.customTexts.some((text) => text.id === id)
    || Object.values(state.profiles).some((profile) => profile.customTexts.some((text) => text.id === id));
  const restoreOldSnapshot = () => {
    const restored = [{ ...oldText }];
    state.customTexts = restored;
    state.profiles.de.customTexts = restored;
    state.profiles.fr.customTexts = [];
  };

  const actions = await evaluateLibraryOps({
    "../state.js": {
      state,
      saveState() {},
      clearLastReadTextId() {}
    },
    "../toast.js": { showToast() {} },
    "../render.js": { render() {}, ensureCurrentText() {} },
    "../views/library.js": { renderLibrary() {} },
    "../books.js": {
      bookTexts,
      clearBookTextCache() {},
      async loadCustomTextContent(text) {
        calls.push(`load:${text.id}`);
        return "fresh synced body";
      }
    },
    "../vocab-index-client.js": { invalidateBookId() {} },
    "../i18n.js": { t: (key) => key },
    "../bridge-commit.js": {
      async saveStateAndReloadBridge() {
        calls.push("save");
        if (saveFails) throw new Error("disk full");
      },
      async reloadBridgeSnapshot() {
        calls.push("reload");
        if (reloadSucceeds) restoreOldSnapshot();
        return reloadSucceeds;
      }
    },
    "../store-bridge.js": {
      async upsertStoredText(text) { calls.push(`upsert:${text.id}:${text.text}`); },
      async deleteStoredText(id) { calls.push(`delete:${id}`); }
    },
    "./profile-library.js": {
      archiveBookId() {},
      clearCurrentBookSelectionIfMatches(id) {
        if (state.currentTextId !== id) return false;
        state.currentTextId = null;
        state.selectedWord = null;
        return true;
      },
      forgetArchivedBook() {},
      hideBuiltInBookId() { return false; },
      isCustomTextReferenced: isReferenced,
      moveCustomTextToProfile() {
        state.customTexts.splice(0, 1);
        state.profiles.fr.customTexts.push(newText);
        state.readerPages[newText.id] = state.readerPages[oldText.id];
        delete state.readerPages[oldText.id];
        state.readerScrolls[newText.id] = state.readerScrolls[oldText.id];
        delete state.readerScrolls[oldText.id];
        state.readerScrollsPerPage[`${newText.id}-p4`] = state.readerScrollsPerPage[`${oldText.id}-p4`];
        delete state.readerScrollsPerPage[`${oldText.id}-p4`];
        state.preferences.lastReadTextIds.fr = newText.id;
        return { oldId: oldText.id, newId: newText.id, textObj: newText };
      },
      moveUserBookToProfile() { return null; },
      planCustomTextMove() {
        return { oldId: oldText.id, newId: newText.id, textObj: newText };
      },
      removeUserBookFromActiveProfile() { return null; }
    }
  }, {
    window: { __qtBridge: true },
    console: { warn() {} },
    fetch: async () => { throw new Error("unexpected fetch"); }
  });

  return { result: await actions.moveBookToProfile(oldText.id, "fr", true), calls, state };
}

describe("durable custom-text profile moves", () => {
  it("keeps a shared legacy body after a successful move", async () => {
    const { result, calls } = await runMove({ saveFails: false, sharedOldId: true });

    assert.equal(result, true);
    assert.deepEqual(calls, [
      "load:legacy-book",
      "upsert:fr-legacy-book:fresh synced body",
      "save"
    ]);
  });

  it("never deletes the old body when the profile save fails", async () => {
    const { result, calls, state } = await runMove({ saveFails: true, sharedOldId: false });

    assert.equal(result, false);
    assert.deepEqual(calls, [
      "load:legacy-book",
      "upsert:fr-legacy-book:fresh synced body",
      "save",
      "reload",
      "delete:fr-legacy-book"
    ]);
    assert.equal(calls.includes("delete:legacy-book"), false);
    assert.equal(state.currentTextId, "legacy-book");
    assert.equal(state.readerPage, 4);
    assert.equal(JSON.stringify(state.readerPages), JSON.stringify({ "legacy-book": 4 }));
    assert.equal(JSON.stringify(state.readerScrolls), JSON.stringify({
      "legacy-book": { scrollTop: 720, wordIndex: 42 }
    }));
    assert.equal(JSON.stringify(state.readerScrollsPerPage), JSON.stringify({ "legacy-book-p4": 720 }));
    assert.equal(JSON.stringify(state.preferences.lastReadTextIds), JSON.stringify({ de: "legacy-book" }));
  });

  it("keeps the moved state intact when recovery snapshot application is rejected", async () => {
    const { result, calls, state } = await runMove({
      saveFails: true,
      sharedOldId: false,
      reloadSucceeds: false
    });

    assert.equal(result, false);
    assert.deepEqual(calls, [
      "load:legacy-book",
      "upsert:fr-legacy-book:fresh synced body",
      "save",
      "reload"
    ]);
    assert.equal(state.currentTextId, null);
    assert.equal(state.readerPages["fr-legacy-book"], 4);
    assert.equal(state.readerPages["legacy-book"], undefined);
    assert.equal(state.profiles.fr.customTexts[0].id, "fr-legacy-book");
  });
});
