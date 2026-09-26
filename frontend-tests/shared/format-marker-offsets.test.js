// Reader offsets index the text without **bold**/*italic* markers. Anything
// that maps them back onto the book text has to use that same marker-free
// text, or it lands on an earlier word (wrong example sentence, wrong Ctrl+F
// highlight).
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __qtBridge: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout, clearTimeout, scrollTo() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  documentElement: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} }, dataset: {}, style: {} },
  body: { contains() { return false; } }
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.HTMLElement = class {};
globalThis.Node = { TEXT_NODE: 3 };
globalThis.CSS = { escape: (value) => value };

const { getSentenceForWord, normalizeWord, resolveVocabularyKey } = await import("../../dist/web/js/tokenizer_v2.js");
const { getReaderSession, getCachedReaderWord } = await import("../../dist/web/js/reader/session.js");
const { selectWord, setWordStatus } = await import("../../dist/web/js/vocab-actions.js");
const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { els } = await import("../../dist/web/js/dom.js");

const raw = "**A** **B** **C** **D** **E** **F** intro. The dog barks. The dog sleeps.";
const book = { id: "formatted", text: raw };

describe("format markers and reader offsets", () => {
  it("keeps the marker-free text the offsets refer to", () => {
    const session = getReaderSession(book, "en", "modern");
    assert.equal(session.plain, "A B C D E F intro. The dog barks. The dog sleeps.");
    const dogs = session.tokens
      .map((token, index) => ({ token, offset: session.globalCharOffsets[index] }))
      .filter(({ token }) => token.value === "dog");
    for (const { offset } of dogs) assert.equal(session.plain.slice(offset, offset + 3), "dog");
  });

  it("saves the sentence of the clicked occurrence", () => {
    const session = getReaderSession(book, "en", "modern");
    const secondDog = session.tokens
      .map((token, index) => ({ token, wordIndex: session.globalWordIndexes[index] }))
      .filter(({ token }) => token.value === "dog")[1].wordIndex;
    const cached = getCachedReaderWord(book, "en", "modern", secondDog);
    const sentence = getSentenceForWord(session.plain, "dog", "en", "modern", secondDog, cached.characterIndex, cached.word);
    assert.equal(sentence, "The dog sleeps.");
  });
});

describe("saving words from formatted texts", () => {
  const formatted = "Intro. The **dog** barks. The *dog* sleeps.";

  beforeEach(() => {
    const defaults = createDefaultState();
    replaceState({
      ...defaults,
      currentView: "reader",
      customTexts: [{ id: "formatted", title: "Formatted", text: formatted, lang: "en" }],
      currentTextId: "formatted",
      preferences: { ...defaults.preferences, learningLanguage: "en", autoLearnOnClick: false, autoTranslateWords: false }
    }, { save: false });
    const text = () => ({ textContent: "" });
    Object.assign(els, { navItems: [], views: [], pageTitle: text(), overallCount: text(), pillKnown: text(), pillLearning: text(), pillNew: text() });
  });

  it("selectWord keeps the sentence of the clicked occurrence", () => {
    const session = getReaderSession(state.customTexts[0], "en", state.preferences.wordDetectionAlgorithm || "modern");
    const secondDog = session.tokens
      .map((token, index) => ({ token, wordIndex: session.globalWordIndexes[index] }))
      .filter(({ token }) => token.value === "dog")[1].wordIndex;

    selectWord("dog", normalizeWord, false, secondDog);

    assert.deepEqual(state.vocab.dog.examples, ["The dog sleeps."]);
  });

  it("a status change saves the example without format markers", () => {
    setWordStatus("dog", "learning");

    assert.equal(state.vocab.dog.status, "learning");
    assert.deepEqual(state.vocab.dog.examples, ["The dog barks."]);
  });
});

describe("saving a phrase selected in the reader", () => {
  // The reader's DOM: word tokens with the text between them.
  function renderReaderText(parts) {
    const nodes = parts.map((part) => typeof part === "string"
      ? { nodeType: 3, textContent: part }
      : Object.assign(new HTMLElement(), {
        nodeType: 1,
        textContent: part.token,
        dataset: {},
        classList: { contains: (name) => name === "word-token" },
        closest: () => null
      }));
    els.readerText = {
      childNodes: nodes,
      dataset: { renderId: String(Math.random()) },
      querySelectorAll: (selector) => selector === ".word-token" ? nodes.filter((node) => node.nodeType === 1) : []
    };
    els.wordPanel = { parentElement: null, classList: { add() {}, remove() {} }, dataset: {} };
  }

  function selectPhrase(language, parts, rangeText) {
    const defaults = createDefaultState();
    replaceState({ ...defaults, currentView: "reader", preferences: { ...defaults.preferences, learningLanguage: language, autoTranslateWords: false } }, { save: false });
    const text = () => ({ textContent: "" });
    Object.assign(els, { navItems: [], views: [], pageTitle: text(), overallCount: text(), pillKnown: text(), pillLearning: text(), pillNew: text() });
    renderReaderText(parts);
    const tokens = parts.filter((part) => typeof part !== "string").length;
    state.readerSelectionRange = { anchor: 0, focus: tokens - 1 };
    state.selectedWord = resolveVocabularyKey(rangeText, state.vocab, language);
    return state.selectedWord;
  }

  it("keeps the words as written but not the punctuation between them", () => {
    const key = selectPhrase("fr", [{ token: "Bonjour" }, "», ", { token: "dit-il" }], "Bonjour», dit-il");
    setWordStatus(key, "learning");
    assert.equal(state.vocab[key].word, "Bonjour dit-il");
  });

  it("keeps an elided article", () => {
    const key = selectPhrase("fr", [{ token: "L'homme" }, " ", { token: "est" }], "L'homme est");
    setWordStatus(key, "learning");
    assert.equal(key, "homme est");
    assert.equal(state.vocab[key].word, "L'homme est");
  });
});
