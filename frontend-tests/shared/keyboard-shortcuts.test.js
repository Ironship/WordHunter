import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let querySelector = () => null;

globalThis.window = {
  __qtBridge: false,
  dispatchEvent() {},
  matchMedia() { return { matches: false, addEventListener() {} }; }
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
class FakeElement {
  static [Symbol.hasInstance](value) {
    return value !== null && typeof value === "object";
  }
}
globalThis.HTMLElement = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.HTMLDialogElement = FakeElement;
globalThis.HTMLInputElement = FakeElement;
globalThis.HTMLSelectElement = FakeElement;
globalThis.document = {
  activeElement: null,
  body: { contains() { return false; } },
  documentElement: {
    dataset: { platform: "desktop" },
    style: { setProperty() {} },
    classList: { toggle() {}, remove() {} }
  },
  addEventListener() {},
  getElementById() { return null; },
  querySelector(selector) { return querySelector(selector); },
  querySelectorAll() { return []; }
};

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { handleGlobalKeydown } = await import("../../dist/web/js/events/navigation.js");
const { handleGlobalKeys } = await import("../../dist/web/js/events/keyboard/global-keys.js");
const { handleReaderKeys } = await import("../../dist/web/js/events/keyboard/reader-keys.js");
const {
  applyPendingReaderPageFocus,
  applyPendingReaderWordFocus,
  findCurrentReaderToken
} = await import("../../dist/web/js/reader/word-navigation.js");
const { handleFlashcardKeys } = await import("../../dist/web/js/events/keyboard/flashcards-keys.js");
const { els } = await import("../../dist/web/js/dom.js");
Object.assign(els, {
  navItems: [],
  views: [],
  pageTitle: {},
  overallCount: {},
  pillKnown: {},
  pillLearning: {},
  pillNew: {}
});

function keyEvent(overrides = {}) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { closest: () => null },
    preventDefault() { this.defaultPrevented = true; },
    ...overrides
  };
}

function resetState(view = "reader") {
  replaceState({ ...createDefaultState(), currentView: view, selectedWord: "wort" }, { save: false });
  querySelector = () => null;
}

describe("keyboard shortcut dispatch", () => {
  it("routes Ctrl+1..4 to the active image results before Reader grading", () => {
    resetState("reader");
    let selected = 0;
    let uploaded = 0;
    const container = {
      querySelector: () => ({ click() { uploaded += 1; } }),
      querySelectorAll: () => [
        { click() {} },
        { click() { selected += 1; } },
        { click() {} }
      ]
    };
    querySelector = (selector) => selector.startsWith('[id^="image-search-results-"') ? container : null;

    const second = keyEvent({ key: "2", code: "Digit2", ctrlKey: true });
    handleGlobalKeydown(second);
    assert.equal(second.defaultPrevented, true);
    assert.equal(selected, 1);

    const upload = keyEvent({ key: "4", code: "Digit4", ctrlKey: true });
    handleGlobalKeydown(upload);
    assert.equal(upload.defaultPrevented, true);
    assert.equal(uploaded, 1);

    const azertyUpload = keyEvent({ key: "'", code: "Digit4", ctrlKey: true, shiftKey: true });
    handleGlobalKeydown(azertyUpload);
    assert.equal(azertyUpload.defaultPrevented, true);
    assert.equal(uploaded, 2);
  });

  it("does not treat modified letters or numbers as destructive Reader shortcuts", () => {
    resetState("reader");
    let gradeClicks = 0;
    querySelector = (selector) => selector === '[data-in-text-grade="4"]'
      ? { click() { gradeClicks += 1; } }
      : null;

    assert.equal(handleReaderKeys(keyEvent({ key: "4", code: "Digit4", ctrlKey: true }), "4"), false);
    assert.equal(handleReaderKeys(keyEvent({ key: "x", code: "KeyX", ctrlKey: true }), "x"), false);
    assert.equal(gradeClicks, 0);
  });

  it("prioritizes an in-text grade over Smart Suggestion on key 5", () => {
    resetState("reader");
    let gradeClicks = 0;
    let suggestionClicks = 0;
    querySelector = (selector) => {
      if (selector === '[data-in-text-grade="5"]') return { click() { gradeClicks += 1; } };
      if (selector === "#word-panel [data-suggest-word]") return { click() { suggestionClicks += 1; } };
      return null;
    };

    assert.equal(handleReaderKeys(keyEvent({ key: "5", code: "Digit5" }), "5"), true);
    assert.equal(gradeClicks, 1);
    assert.equal(suggestionClicks, 0);
  });

  it("does not let unavailable Flashcard actions fall through to global navigation", () => {
    resetState("flashcards");
    for (const key of ["m", "y", "i"]) {
      const event = keyEvent({ key, code: `Key${key.toUpperCase()}` });
      handleGlobalKeydown(event);
      assert.equal(event.defaultPrevented, true, key);
      assert.equal(state.currentView, "flashcards", key);
    }
  });

  it("does not let unavailable Reader actions fall through to global navigation", () => {
    resetState("reader");
    state.selectedWord = null;
    for (const key of ["m", "y", "i"]) {
      const event = keyEvent({ key, code: `Key${key.toUpperCase()}` });
      handleGlobalKeydown(event);
      assert.equal(event.defaultPrevented, true, key);
      assert.equal(state.currentView, "reader", key);
    }
  });

  it("does not map browser-style modified letters to application views", () => {
    resetState("library");
    const event = keyEvent({ key: "s", code: "KeyS", ctrlKey: true });
    assert.equal(handleGlobalKeys(event, "s", false), false);
    assert.equal(state.currentView, "library");
    assert.equal(event.defaultPrevented, false);
  });

  it("requires Alt for view navigation so typed letters cannot switch tabs", () => {
    resetState("library");
    const plain = keyEvent({ key: "s", code: "KeyS" });
    assert.equal(handleGlobalKeys(plain, "s", false), false);
    assert.equal(state.currentView, "library");

    const modified = keyEvent({ key: "?", code: "Slash", altKey: true, shiftKey: true });
    assert.equal(handleGlobalKeys(modified, "?", false), true);
    assert.equal(state.currentView, "help");
    assert.equal(modified.defaultPrevented, true);
  });

  it("suppresses application shortcuts while a dialog is open", () => {
    resetState("library");
    querySelector = (selector) => selector === "dialog[open]" ? {} : null;
    const event = keyEvent({ key: "v", code: "KeyV" });
    handleGlobalKeydown(event);
    assert.equal(state.currentView, "library");
    assert.equal(event.defaultPrevented, false);
  });

  it("returns Ctrl+Enter to the exact selected Reader token", () => {
    resetState("reader");
    const first = { dataset: { word: "wort", wordIndex: "4" } };
    const selected = { dataset: { word: "wort", wordIndex: "18" } };
    state.selectedWordIndex = 18;
    document.activeElement = null;
    window.lastActiveToken = { dataset: { word: "wort", wordIndex: "18" } };

    assert.equal(findCurrentReaderToken([first, selected]), selected);

    const readerKeys = readFileSync(new URL("../../dist/web/js/events/keyboard/reader-keys.js", import.meta.url), "utf8");
    assert.match(readerKeys, /const token = findCurrentReaderToken\(tokens\);/);
    assert.doesNotMatch(readerKeys, /findCurrentReaderToken\(tokens\) \|\| tokens\[0\]/);
  });

  it("focuses the first Reader token after a page change without selecting it", () => {
    resetState("reader");
    const focusCalls = [];
    const first = {
      dataset: { word: "first", wordIndex: "40" },
      focus(options) { focusCalls.push(options); }
    };
    const readerText = {
      dataset: {},
      querySelector(selector) { return selector === ".word-token" ? first : null; }
    };

    readerText.dataset.focusAfterPageChange = "1";
    assert.equal(applyPendingReaderPageFocus(readerText), true);
    assert.deepEqual(focusCalls, [{ preventScroll: true }]);
    assert.equal(window.lastActiveToken, first);
    assert.equal(readerText.dataset.focusAfterPageChange, undefined);
    assert.equal(state.selectedWord, "wort");
  });

  it("restores focus to the exact repeated Reader occurrence after rendering", () => {
    const focusCalls = [];
    const exact = {
      dataset: { word: "target phrase", wordIndex: "17" },
      focus(options) { focusCalls.push(options); }
    };
    const selectors = [];
    const readerText = {
      dataset: { focusWordIndex: "17", focusWord: "target phrase" },
      querySelector(selector) {
        selectors.push(selector);
        return selector.includes('data-word-index="17"') ? exact : null;
      }
    };

    assert.equal(applyPendingReaderWordFocus(readerText), true);
    assert.deepEqual(selectors, ['.word-token[data-word-index="17"]']);
    assert.deepEqual(focusCalls, [{ preventScroll: true }]);
    assert.equal(window.lastActiveToken, exact);
    assert.equal(readerText.dataset.focusWordIndex, undefined);
    assert.equal(readerText.dataset.focusWord, undefined);
  });

  it("handles Ctrl+Enter from a word-panel field without falling back to the first token", () => {
    resetState("reader");
    const event = keyEvent({
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
      target: { isContentEditable: false, closest: () => ({}) }
    });

    handleGlobalKeydown(event);

    assert.equal(event.defaultPrevented, true);
  });

  it("does not route Ctrl+Enter through a dialog or repeated keydown", () => {
    resetState("reader");
    querySelector = (selector) => selector === "dialog[open]" ? {} : null;
    const dialogEvent = keyEvent({ key: "Enter", code: "Enter", ctrlKey: true });
    handleGlobalKeydown(dialogEvent);
    assert.equal(dialogEvent.defaultPrevented, false);

    querySelector = () => null;
    const repeatedEvent = keyEvent({ key: "Enter", code: "Enter", ctrlKey: true, repeat: true });
    handleGlobalKeydown(repeatedEvent);
    assert.equal(repeatedEvent.defaultPrevented, false);
  });
});

describe("keyboard shortcut documentation", () => {
  const locales = ["en", "pl", "de", "es", "fr", "it", "ja", "ru", "uk"];

  it("documents every shared shortcut group in every locale", () => {
    for (const locale of locales) {
      const data = JSON.parse(readFileSync(new URL(`../../dist/web/i18n/${locale}.json`, import.meta.url)));
      assert.ok(data.help.shortcutScope, `${locale}.help.shortcutScope`);
      assert.match(data.help.navKeys.settings, /<kbd>Alt<\/kbd>/, `${locale}.help.navKeys.settings`);
      for (const key of ["search", "theme", "offlineDictionary", "escape"]) {
        assert.ok(data.help.navKeys[key], `${locale}.help.navKeys.${key}`);
      }
      assert.ok(data.help.readerKeys.activate, `${locale}.help.readerKeys.activate`);
      assert.ok(data.help.editorKeys.word, `${locale}.help.editorKeys.word`);
      assert.ok(data.help.editorKeys.book, `${locale}.help.editorKeys.book`);
      assert.match(data.help.actionKeys.removeStatus, /translation|tłumaczeniem|Übersetzung|traducción|traduction|traduzione|翻訳|перевод|переклад/i);
    }
  });

  it("keeps Reader bubbling and pagination tooltip fixes wired", () => {
    const reader = readFileSync(new URL("../../dist/web/js/views/reader.js", import.meta.url), "utf8");
    const pagination = readFileSync(new URL("../../dist/web/js/reader/pagination.js", import.meta.url), "utf8");
    assert.match(reader, /event\.key === "Enter" && state\.selectedWord && document\.querySelector\("\[data-in-text-answer\]"\)/);
    assert.doesNotMatch(reader, /event\.key === "5"/);
    assert.match(pagination, /title="\$\{escapeAttribute\(tFn\("reader\.prevPageTitle"\)\)\}"/);
    assert.match(pagination, /title="\$\{escapeAttribute\(tFn\("reader\.nextPageTitle"\)\)\}"/);
    assert.match(pagination, /readerText\.dataset\.focusAfterPageChange = "1"/);
  });
});
