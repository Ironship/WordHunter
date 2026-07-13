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
const { setWordStatus, updateWordField } = await import("../../dist/web/js/vocab-actions.js");

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
});
