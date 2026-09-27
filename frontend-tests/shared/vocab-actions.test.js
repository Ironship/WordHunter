import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

let saveWrites = 0;

function classListStub() {
  return {
    add() {},
    remove() {},
    toggle() {},
    contains() { return false; }
  };
}

function textNode() {
  return { textContent: "", dataset: {}, classList: classListStub() };
}

globalThis.window = {
  __qtBridge: false,
  WH_TOKEN: "",
  addEventListener() {},
  dispatchEvent() {}
};

globalThis.document = {
  documentElement: { dataset: {}, style: {}, classList: classListStub() },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};

globalThis.localStorage = {
  getItem() { return null; },
  setItem() { saveWrites += 1; },
  removeItem() {}
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { els } = await import("../../dist/web/js/dom.js");
const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { confirmAndDeleteWord, maybeAutoTranslateWord, selectWord, setWordStatus, updateWordField } = await import("../../dist/web/js/vocab-actions.js");
const { getOrCreateEntry } = await import("../../dist/web/js/views/vocabulary.js");

function vocabEntry(overrides = {}) {
  return {
    status: "learning",
    translation: "",
    note: "",
    examples: [],
    updatedAt: "2026-06-01T00:00:00.000Z",
    interval: 0,
    repetition: 0,
    efactor: 2.5,
    stability: 0,
    difficulty: 5,
    srsAlgorithm: "fsrs",
    nextDate: "2026-06-02",
    ...overrides
  };
}

function resetVocabState(vocab = {}) {
  const defaults = createDefaultState();
  const profile = { vocab, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [] };
  replaceState({
    ...defaults,
    currentView: "help",
    preferences: { ...defaults.preferences, learningLanguage: "de", autoTranslateWords: false },
    profiles: { de: profile },
    vocab: profile.vocab,
    customTexts: profile.customTexts,
    userBooks: profile.userBooks,
    hiddenBuiltInBooks: profile.hiddenBuiltInBooks,
    archivedBookIds: profile.archivedBookIds
  }, { save: false });
  Object.assign(els, {
    navItems: [],
    views: [],
    pageTitle: textNode(),
    overallCount: textNode(),
    pillKnown: textNode(),
    pillLearning: textNode(),
    pillNew: textNode()
  });
  saveWrites = 0;
}

describe("vocabulary actions", () => {
  beforeEach(() => resetVocabState());

  it("does not bump updatedAt when setting the same status", () => {
    resetVocabState({
      haus: vocabEntry({ status: "known", updatedAt: "2026-06-10T00:00:00.000Z", knownAt: "2026-06-09T00:00:00.000Z" })
    });

    setWordStatus("haus", "known");

    assert.equal(state.vocab.haus.updatedAt, "2026-06-10T00:00:00.000Z");
    assert.equal(state.vocab.haus.knownAt, "2026-06-09T00:00:00.000Z");
    assert.equal(saveWrites, 0);
  });

  it("creates and updates one entry across differently cased spellings", () => {
    const entry = getOrCreateEntry("Am");
    const sameEntry = getOrCreateEntry("AM");
    updateWordField("am", "translation", "at the");
    setWordStatus("AM", "known");

    assert.equal(entry, sameEntry);
    assert.deepEqual(Object.keys(state.vocab), ["am"]);
    assert.equal(state.vocab.am.word, "Am");
    assert.equal(state.vocab.am.translation, "at the");
    assert.equal(state.vocab.am.status, "known");
  });

  it("canonicalizes the original token before a generic normalizer for Turkish", () => {
    const defaults = createDefaultState();
    const profile = {
      vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [],
      preferences: { translationSourceLanguage: "tr_TR", translationTargetLanguage: "en" }
    };
    replaceState({
      ...defaults,
      currentView: "help",
      preferences: {
        ...defaults.preferences,
        learningLanguage: "other",
        translationSourceLanguage: "tr_TR",
        translationTargetLanguage: "en",
        autoTranslateWords: false
      },
      profiles: { other: profile },
      vocab: profile.vocab,
      customTexts: profile.customTexts,
      userBooks: profile.userBooks,
      hiddenBuiltInBooks: profile.hiddenBuiltInBooks,
      archivedBookIds: profile.archivedBookIds
    }, { save: false });

    selectWord("I", (word) => word.toLowerCase());

    assert.deepEqual(Object.keys(state.vocab), ["ı"]);
    assert.equal(state.vocab["ı"].word, "I");
  });

  it("does not bump updatedAt when setting the same vocabulary field value", () => {
    resetVocabState({
      haus: vocabEntry({
        translation: "house",
        translationSource: "translator",
        updatedAt: "2026-06-11T00:00:00.000Z"
      })
    });

    updateWordField("haus", "translation", "house");

    assert.equal(state.vocab.haus.updatedAt, "2026-06-11T00:00:00.000Z");
    assert.equal(state.vocab.haus.translationSource, "translator");
    assert.equal(saveWrites, 0);
  });

  it("normalizes, clears, and no-ops an optional article", () => {
    resetVocabState({
      haus: vocabEntry({ article: "das", updatedAt: "2026-06-11T00:00:00.000Z" })
    });

    updateWordField("haus", "article", "  die  ");
    assert.equal(state.vocab.haus.article, "die");
    assert.equal(saveWrites, 1);

    const updatedAt = state.vocab.haus.updatedAt;
    updateWordField("haus", "article", "die");
    assert.equal(state.vocab.haus.updatedAt, updatedAt);
    assert.equal(saveWrites, 1);

    updateWordField("haus", "article", "   ");
    assert.equal(Object.hasOwn(state.vocab.haus, "article"), false);
    assert.equal(saveWrites, 2);
  });

  it("does not apply a late automatic translation after switching profiles", async () => {
    const germanEntry = vocabEntry({ word: "Haus" });
    resetVocabState({ haus: germanEntry });
    state.preferences.autoTranslateWords = true;
    const previousFetch = globalThis.fetch;
    let finishRequest;
    globalThis.fetch = () => new Promise((resolve) => {
      finishRequest = () => resolve(new Response(JSON.stringify({ translated: "house", engine: "google" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });

    try {
      const pending = maybeAutoTranslateWord("haus", state.vocab.haus);
      while (!finishRequest) await Promise.resolve();
      state.preferences.learningLanguage = "fr";
      state.vocab = { haus: vocabEntry({ word: "Haus" }) };
      finishRequest();

      assert.equal(await pending, false);
      assert.equal(germanEntry.translation, "");
      assert.equal(state.vocab.haus.translation, "");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("asks before deleting a word that has progress, and only deletes on confirm", async () => {
    // Minimal element stand-in for showConfirmDialog (dialog-backdrop.ts).
    const element = () => {
      const listeners = new Map();
      return {
        style: {}, dataset: {}, children: [], className: "", textContent: "", type: "",
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type) { listeners.delete(type); },
        fire(type) { listeners.get(type)?.({ type, target: this }); },
        showModal() {}, close() {}, remove() {}
      };
    };
    const dialogs = [];
    const findByClass = (node, className) => node.className === className
      ? node
      : node.children.map((child) => findByClass(child, className)).find(Boolean);
    const waitForDialog = async (count) => {
      for (let i = 0; i < 200 && dialogs.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(dialogs.length, count, "confirmation dialog shown");
      return dialogs[count - 1];
    };
    document.createElement = element;
    document.body = { appendChild(node) { dialogs.push(node); } };
    try {
      resetVocabState({
        haus: vocabEntry({ word: "Haus", translation: "house" }),
        baum: vocabEntry({ word: "Baum", lastReviewedAt: "2026-06-01T00:00:00.000Z", repetition: 2 }),
        neu: vocabEntry({ word: "neu", status: "new" }),
        bekannt: vocabEntry({ word: "bekannt", status: "known", knownAt: "2026-06-01T00:00:00.000Z" })
      });

      const cancelled = confirmAndDeleteWord("Haus");
      findByClass(await waitForDialog(1), "secondary-button").fire("click");
      assert.equal(await cancelled, false);
      assert.ok(state.vocab.haus, "cancel keeps the entry");

      const confirmed = confirmAndDeleteWord("Haus");
      findByClass(await waitForDialog(2), "danger-button").fire("click");
      assert.equal(await confirmed, true);
      assert.equal(state.vocab.haus, undefined);

      const reviewed = confirmAndDeleteWord("baum");
      findByClass(await waitForDialog(3), "secondary-button").fire("click");
      assert.equal(await reviewed, false);
      assert.ok(state.vocab.baum, "review history alone needs a confirmation");

      const known = confirmAndDeleteWord("bekannt");
      findByClass(await waitForDialog(4), "secondary-button").fire("click");
      assert.equal(await known, false);
      assert.ok(state.vocab.bekannt, "a known word alone needs a confirmation");

      // Nothing to lose: a new word without translation, note, image,
      // examples or reviews.
      assert.equal(await confirmAndDeleteWord("neu"), true);
      assert.equal(dialogs.length, 4);
      assert.equal(state.vocab.neu, undefined);
    } finally {
      delete document.createElement;
      delete document.body;
    }
  });
});
