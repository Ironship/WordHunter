import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Flush pending microtasks + one macrotask. The AI explain flow awaits only
 * already-resolved promises (mocked deps, no timers/IO), so a single macrotask
 * is guaranteed to run after the whole chain — but this contract is implicit:
 * adding timers/debounces to the flow would make these waits flaky.
 */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    }
  };
}

function eventTarget(extra = {}) {
  const listeners = new Map();
  const target = {
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      let result;
      for (const listener of listeners.get(type) || []) {
        result = listener.call(this, { type, target: this, ...event });
      }
      return result;
    },
    click() {
      return target.dispatch("click", { stopPropagation() {} });
    },
    ...extra
  };
  return target;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function evaluateWithMocks(file, importValues, globals = {}, dynamicImportValues = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  const modules = new Map();
  const createMock = (specifier, values) => new vm.SyntheticModule(
    Object.keys(values),
    function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    },
    { context, identifier: `mock:${specifier}` }
  );

  for (const [specifier, values] of Object.entries({ ...importValues, ...dynamicImportValues })) {
    modules.set(specifier, createMock(specifier, values));
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

describe("lazy library statistics", () => {
  it("sorts from retained statistics after full book bodies are evicted", async () => {
    const bookList = { innerHTML: "", querySelectorAll: () => [] };
    let fullHydrations = 0;
    const state = {
      currentView: "library",
      filters: {
        libraryQuery: "",
        libraryLevel: "all",
        librarySort: "length",
        librarySortReverse: false,
        libraryArchive: "active"
      },
      preferences: {
        learningLanguage: "en",
        wordDetectionAlgorithm: "modern",
        showCardStats: false,
        showCovers: false,
        cardStatsMode: "percentages"
      },
      vocab: {},
      customTexts: [],
      userBooks: [],
      archivedBookIds: []
    };
    const { renderLibrary } = await evaluateWithMocks("dist/web/js/views/library.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: {
        bookList,
        librarySearch: {},
        levelFilter: {},
        librarySort: {},
        librarySortReverse: { dataset: {} },
        libraryArchiveFilter: {},
        libraryPanel: null,
        libraryFiltersToggle: null,
        librarySidebarResizer: null
      } },
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
        getAllBooks: () => [
          { id: "short", title: "Short", lang: "en" },
          { id: "long", title: "Long", lang: "en" }
        ],
        bookTexts: { has: () => false, get: () => undefined, peek: () => undefined },
        hydrateActiveLibraryTexts: async () => { fullHydrations += 1; },
        getLibraryContentGeneration: () => 0,
        isBookTextCacheStale: () => false,
        loadBookText: async () => "",
        loadCustomTextContent: async () => ""
      },
      "../stats-cache.js": {
        getCachedBookTextStats: (id) => id === "long"
          ? { unique: 8, known: 2, learning: 2, ignored: 1, new: 5 }
          : { unique: 2, known: 1, learning: 0, ignored: 0, new: 1 },
        getCachedTextStats: () => null,
        prepareTextStats: () => "empty-vocab"
      },
      "../i18n.js": { t: (key) => key, getLocale: () => "en" },
      "../panel-resizer.js": { bindSidebarResizer() {} },
      "../translator-preferences.js": { effectiveLearningLanguage: () => "en" }
    }, {
      window: {},
      requestAnimationFrame: () => 1,
      Intl
    });

    renderLibrary();

    assert.ok(bookList.innerHTML.indexOf("Long") < bookList.innerHTML.indexOf("Short"));
    assert.equal(fullHydrations, 1);
  });
});

async function globalActionsHarness(options = {}) {
  const listeners = new Map();
  const calls = [];
  const state = {
    currentView: "reader",
    selectedWord: "wort",
    selectedWordIndex: 3,
    readerSelectionRange: null,
    preferences: { highlightTokens: true, readerWordPanelVisible: true },
    readerFontSize: 18,
    ...options.state
  };
  class FakeInput {
    static [Symbol.hasInstance](value) { return value?.isInput === true; }
  }
  const document = {
    documentElement: { classList: classList() },
    addEventListener(type, listener) { listeners.set(type, listener); },
    getElementById(id) { return options.elements?.[id] || null; }
  };
  const module = await evaluateWithMocks("dist/web/js/events/global-actions.js", {
    "../state.js": { registerFrontendStateFlusher() {}, state },
    "../reader/selection.js": {
      clearReaderSelection() {
        calls.push(["clear", state.selectedWord]);
        state.selectedWord = null;
      }
    },
    "../views/vocabulary.js": { gradeReview() {}, loadMoreVocab() {}, removeFromSrs() {} },
    "../vocab-actions.js": {
      deleteWord() {}, handleReviewAction() {}, ignoreWord() {}, removeWordImage() {},
      setWordImage() {}, setWordStatus() {}, updateWordField() {}
    },
    "../sync-actions.js": { exportVocabularySelection() {} },
    "../preferences.js": { setReaderFontSize() {}, syncSettingsControls() {}, updatePreferenceValue() {} },
    "../youglish.js": { openYouGlish() {} },
    "../tts.js": {
      speakText(text, container, onFinish, speakOptions) { calls.push(["speakText", text, container, speakOptions]); },
      speakWord(word) { calls.push(["speak", word]); },
      stopSpeaking() {}
    },
    "../tokenizer_v2.js": {
      getTextFromWordIndex: options.getTextFromWordIndex || (() => null)
    },
    "../translator-preferences.js": {
      effectiveLearningLanguage() { return "de"; }
    },
    "./shared.js": {
      copySelectedWordToClipboard() {},
      getSelectedReaderActionText() { return state.selectedWord || ""; },
      openDictionary() {}
    },
    "./image-search.js": { renderImageSearch() {} },
    "../vocabulary/article.js": {
      formatHeadword(word, article) { return article ? (article.endsWith("'") || article.endsWith("’") ? `${article}${word}` : `${article} ${word}`) : word; }
    }
  }, { document, window: {}, HTMLInputElement: FakeInput });
  module.bindGlobalActionEvents();
  return { calls, document, listeners, state };
}

function closestTarget(matches = {}, extra = {}) {
  return {
    closest(selector) { return matches[selector] || null; },
    ...extra
  };
}

describe("focused frontend regressions", () => {
  it("clears every Pocket drawer class when changing views", async () => {
    const removed = [];
    const collapsed = [];
    const dispatched = [];
    const state = { currentView: "library" };
    const module = await evaluateWithMocks("dist/web/js/render.js", {
      "./state.js": { state, saveUiState() {}, getLastReadTextId() { return null; } },
      "./views/shell.js": { renderShell() {} },
      "./views/library.js": { renderLibrary() {} },
      "./reader/renderer.js": { renderReader() {}, getTextById() { return null; } },
      "./reader/selection.js": { updateReaderSelection() {} },
      "./reader/scroll.js": { rememberReaderScrollPosition() {} },
      "./views/vocabulary.js": { renderVocabulary() {}, renderReview() {}, resetReviewPresentation() {} },
      "./views/discover.js": { renderDiscover() {} },
      "./views/graphs.js": { renderGraphs() {} },
      "./views/translator.js": { renderTranslator() {} },
      "./preferences.js": { syncSettingsControls() {} },
      "./i18n.js": { t: (key) => key },
      "./dom.js": { els: {} },
      "./platform.js": { applyPlatformUi() {}, isAndroidPlatform() { return false; } }
    }, {
      document: {
        documentElement: { classList: { remove(...names) { removed.push(...names); } } },
        getElementById(id) {
          return { setAttribute(name, value) { collapsed.push([id, name, value]); } };
        }
      },
      window: { dispatchEvent(event) { dispatched.push(event); } },
      CustomEvent: class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init?.detail; }
      }
    });

    module.setView("help");

    assert.deepEqual(removed, ["pocket-navigation-open", "pocket-import-open", "pocket-word-panel-open"]);
    assert.deepEqual(collapsed, [
      ["pocket-navigation-toggle", "aria-expanded", "false"],
      ["reader-pocket-navigation-toggle", "aria-expanded", "false"],
      ["library-import-toggle", "aria-expanded", "false"]
    ]);
    assert.equal(state.currentView, "help");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].detail.view, "help");
  });

  it("preserves Reader selection for toolbar/dialog clicks and speaks before outside clearing", async () => {
    const { calls, listeners, state } = await globalActionsHarness();
    const click = listeners.get("click");
    const readerSurfaceSelector = "#reader-text, #word-panel, #reader-view .reader-toolbar, dialog";
    const ttsButton = { dataset: { ttsWord: "fallback" } };

    click({
      target: closestTarget({ "[data-tts-word]": ttsButton }),
      composedPath() { return []; }
    });
    assert.deepEqual(calls, [["speak", "wort"], ["clear", "wort"]]);

    for (const surface of ["toolbar", "dialog"]) {
      state.selectedWord = surface;
      const before = calls.length;
      click({
        target: closestTarget({ [readerSurfaceSelector]: { id: surface } }),
        composedPath() { return []; }
      });
      assert.equal(state.selectedWord, surface);
      assert.equal(calls.length, before);
    }
  });

  it("uses the current flashcard payload instead of stale Reader text for TTS", async () => {
    const { calls, listeners } = await globalActionsHarness({
      state: { currentView: "flashcards", selectedWord: "stale-reader-word" }
    });
    const click = listeners.get("click");

    for (const text of ["current-card-word", "Current card sentence."]) {
      click({
        target: closestTarget({ "[data-tts-word]": { dataset: { ttsWord: text } } }),
        composedPath() { return []; }
      });
    }

    assert.deepEqual(calls, [
      ["speak", "current-card-word"],
      ["speak", "Current card sentence."]
    ]);
  });

  it("starts Reader Play at the exact selected repeated word", async () => {
    const sliceCalls = [];
    const tokens = [3, 17, 22].map((wordIndex) => ({
      dataset: { wordIndex: String(wordIndex) },
      classList: { contains() { return false; } }
    }));
    const readerText = {
      dataset: { ttsText: "target first. Other words target selected." },
      querySelectorAll(selector) { return selector === ".word-token" ? tokens : []; },
      contains() { return false; }
    };
    const playButton = { hidden: false };
    const stopButton = { hidden: true };
    const { calls, listeners } = await globalActionsHarness({
      state: { selectedWord: "target", selectedWordIndex: 17, readerSelectionRange: { anchor: 1, focus: 1 } },
      elements: { "reader-text": readerText, "tts-stop-text": stopButton },
      getTextFromWordIndex(text, wordIndex, language, algorithm) {
        sliceCalls.push([text, wordIndex, language, algorithm]);
        return "target selected.";
      }
    });

    listeners.get("click")({
      target: closestTarget({
        "#tts-play-text": playButton,
        "#reader-text, #word-panel, #reader-view .reader-toolbar, dialog": { id: "toolbar" }
      }),
      composedPath() { return []; }
    });

    assert.deepEqual(sliceCalls, [[readerText.dataset.ttsText, 1, "de", "modern"]]);
    const speakCall = calls.find((call) => call[0] === "speakText");
    assert.equal(speakCall[1], "target selected.");
    assert.equal(speakCall[2], readerText);
    assert.equal(speakCall[3].startTokenIndex, 1);
    assert.equal(playButton.hidden, true);
    assert.equal(stopButton.hidden, false);
  });

  it("uses the PDF page word index while keeping the exact overlay token", async () => {
    const sliceCalls = [];
    const tokens = [
      { dataset: { wordIndex: "31", pdfPageWordIndex: "4" }, classList: { contains() { return false; } } },
      { dataset: { wordIndex: "47", pdfPageWordIndex: "9" }, classList: { contains() { return false; } } }
    ];
    const readerText = {
      dataset: { ttsText: "Page text with OCR words and the selected target." },
      querySelectorAll(selector) { return selector === ".word-token" ? tokens : []; },
      contains() { return false; }
    };
    const { calls, listeners } = await globalActionsHarness({
      state: { selectedWord: "target", selectedWordIndex: 47 },
      elements: { "reader-text": readerText, "tts-stop-text": { hidden: true } },
      getTextFromWordIndex(text, wordIndex) {
        sliceCalls.push([text, wordIndex]);
        return "target.";
      }
    });

    listeners.get("click")({
      target: closestTarget({
        "#tts-play-text": { hidden: false },
        "#reader-text, #word-panel, #reader-view .reader-toolbar, dialog": { id: "toolbar" }
      }),
      composedPath() { return []; }
    });

    assert.deepEqual(sliceCalls, [[readerText.dataset.ttsText, 9]]);
    assert.equal(calls.find((call) => call[0] === "speakText")[3].startTokenIndex, 1);
  });

  it("keeps keyboard navigation lightweight and routes swipes through automatic translation", async () => {
    const calls = [];
    const rootClasses = classList(["pocket-word-panel-open"]);
    const state = { selectedWord: "alpha", selectedWordIndex: 3 };
    const token = {
      dataset: { word: "Beta", wordIndex: "17" },
      focus() { calls.push(["focus"]); }
    };
    const navigation = await evaluateWithMocks("dist/web/js/reader/word-navigation.js", {
      "../state.js": { state, saveUiState: () => calls.push(["saveUiState"]) },
      "../tokenizer_v2.js": { normalizeWord: (word) => word.toLowerCase() },
      "../tts.js": { speakWord: (word) => calls.push(["speakWord", word]) },
      "../vocab-actions.js": {
        selectWord(...args) {
          calls.push(["selectWord", ...args]);
          state.selectedWord = args[1](args[0]);
          state.selectedWordIndex = args[3];
        }
      },
      "./selection.js": {
        getReaderWordTokens: () => [],
        setReaderSelectionAnchorFromToken: (value) => calls.push(["anchor", value]),
        updateReaderSelection: (options) => calls.push(["updateReaderSelection", options])
      }
    }, {
      HTMLElement: class {},
      window: { lastActiveToken: null },
      document: { documentElement: { classList: rootClasses }, getElementById: () => null }
    });

    assert.equal(navigation.selectReaderToken(token), true);
    assert.equal(calls.some((call) => call[0] === "selectWord"), false);
    assert.equal(calls.some((call) => call[0] === "saveUiState"), true);
    assert.deepEqual(calls.find((call) => call[0] === "speakWord"), ["speakWord", "Beta"]);
    const selectionUpdate = calls.find((call) => call[0] === "updateReaderSelection");
    assert.equal(selectionUpdate[1].renderPanel, true);

    calls.length = 0;
    rootClasses.add("pocket-mode", "pocket-word-panel-open");
    state.selectedWord = "alpha";
    state.selectedWordIndex = 3;
    assert.equal(navigation.selectReaderToken(token, true, { keepPanelOpen: true, persistWord: true }), true);
    const selection = calls.find((call) => call[0] === "selectWord");
    assert.equal(selection[1], "Beta");
    assert.equal(selection[2](selection[1]), "beta");
    assert.equal(selection[3], false);
    assert.equal(selection[4], 17);
    assert.equal(selection[5].forceSpeak, true);
    assert.equal(state.selectedWord, "beta");
    assert.equal(state.selectedWordIndex, 17);
    assert.equal(rootClasses.contains("pocket-word-panel-open"), true);
    const vocabActions = read("dist/web/js/vocab-actions.js");
    assert.match(vocabActions, /maybeAutoTranslateWord\(word, entry\)/);
    assert.match(vocabActions, /pendingAutoTranslations\.has\(entry\)/);
    assert.match(vocabActions, /state\.currentView === "reader" && state\.selectedWord === word/);
    assert.match(vocabActions, /focusWordIndex = String\(state\.selectedWordIndex\)/);
  });

  it("follows the exact selected Reader occurrence", async () => {
    const first = { dataset: { word: "beta", wordIndex: "3" }, classList: classList() };
    const selected = { dataset: { word: "beta", wordIndex: "17" }, classList: classList() };
    const followed = [];
    const readerText = {
      childNodes: [],
      querySelector: () => null,
      querySelectorAll: () => [first, selected]
    };
    const state = {
      currentTextId: "book-1",
      readerSelectionRange: null,
      selectedWord: "beta",
      selectedWordIndex: 17
    };
    const selection = await evaluateWithMocks("dist/web/js/reader/selection.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: { readerText } },
      "../tokenizer_v2.js": { normalizeWord: (word) => word },
      "./renderer.js": { getTextById: () => ({ id: "book-1" }) },
      "./word-panel.js": { renderWordPanel() {} },
      "./visibility.js": { keepReaderTokenVisible: (token) => followed.push(token) },
      "../views/shell.js": { renderShell() {} }
    }, {
      Node: { TEXT_NODE: 3 },
      HTMLElement: class {}
    });

    selection.updateReaderSelection();

    assert.equal(first.classList.contains("selected"), true);
    assert.equal(selected.classList.contains("selected"), true);
    assert.deepEqual(followed, [selected]);

    followed.length = 0;
    selection.updateReaderSelection({ keepVisible: false });
    assert.deepEqual(followed, []);
  });

  it("clears a stale word selection when the Reader page changes", async () => {
    const state = {
      currentTextId: "book-1",
      readerPage: 1,
      readerPages: {},
      selectedWord: "old",
      selectedWordIndex: 77,
      readerSelectionRange: { anchor: 3, focus: 3 }
    };
    const pagination = await evaluateWithMocks("dist/web/js/reader/pagination.js", {
      "../state.js": { state, saveUiState() {} },
      "../utils.js": { escapeAttribute: String, escapeHtml: String },
      "./renderer.js": { renderReader() {} },
      "./focus.js": { requestReaderPageFocus() {} }
    }, { window: { lastActiveToken: {} } });

    pagination.cacheTotalPages("book-1", 3);
    pagination.changeReaderPage(1);

    assert.equal(state.readerPage, 2);
    assert.equal(state.selectedWord, null);
    assert.equal(state.selectedWordIndex, null);
    assert.equal(state.readerSelectionRange, null);
  });

  it("selects the next word immediately while a ghost card animates out", async () => {
    class FakeElement {
      constructor(classes = []) {
        this.attributes = {};
        this.classList = classList(classes);
        this.dataset = {};
        this.listeners = new Map();
        this.scrollTop = 12;
        this.style = {
          values: { "--word-card-drag-x": "-90px" },
          removeProperty: (name) => { delete this.style.values[name]; }
        };
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      removeEventListener(type, listener) {
        if (this.listeners.get(type) === listener) this.listeners.delete(type);
      }
      dispatchAnimation() { this.listeners.get("animationend")?.({ target: this }); }
      cloneNode() { return new FakeElement(["word-panel", "word-panel-card-dragging", "word-panel-card-snapback"]); }
      querySelectorAll() { return []; }
      removeAttribute(name) { delete this.attributes[name]; }
      setAttribute(name, value) { this.attributes[name] = value; }
      remove() { this.removed = true; }
      focus() {}
      get offsetWidth() { return 320; }
    }

    const ghosts = [];
    const host = {
      appendChild(element) { element.parentElement = this; ghosts.push(element); },
      querySelectorAll() { return ghosts.filter((ghost) => !ghost.removed); }
    };
    const panel = new FakeElement(["word-panel", "word-panel-card-dragging"]);
    panel.parentElement = host;
    const rootClasses = classList(["pocket-word-panel-open"]);
    const state = { selectedWord: "alpha", selectedWordIndex: 3 };
    const selections = [];
    const token = { dataset: { word: "Beta", wordIndex: "17" }, focus() {} };
    const navigation = await evaluateWithMocks("dist/web/js/reader/word-navigation.js", {
      "../state.js": { state, saveUiState() {} },
      "../tokenizer_v2.js": { normalizeWord: (word) => word.toLowerCase() },
      "../tts.js": { speakWord() {} },
      "../vocab-actions.js": {
        selectWord(...args) {
          selections.push(args);
          state.selectedWord = args[1](args[0]);
          state.selectedWordIndex = args[3];
        }
      },
      "./selection.js": { getReaderWordTokens: () => [], setReaderSelectionAnchorFromToken() {}, updateReaderSelection() {} }
    }, {
      HTMLElement: FakeElement,
      window: {
        lastActiveToken: null,
        matchMedia: () => ({ matches: false }),
        setTimeout,
        clearTimeout
      },
      document: {
        documentElement: { classList: rootClasses },
        getElementById: (id) => id === "word-panel" ? panel : null
      }
    });

    assert.equal(navigation.selectReaderToken(token, true, { keepPanelOpen: true, animateDirection: "next", persistWord: true }), true);
    assert.equal(selections.length, 1);
    assert.equal(state.selectedWord, "beta");
    assert.equal(ghosts.length, 1);
    assert.equal(ghosts[0].classList.contains("word-panel-exit-next"), true);
    assert.equal(ghosts[0].classList.contains("word-panel-card-snapback"), false);
    assert.equal(panel.classList.contains("word-panel-enter-next"), true);
    panel.dispatchAnimation();
    assert.equal(ghosts[0].removed, true);
    assert.equal(panel.dataset.wordCardTransition, undefined);
  });

  it("routes unsaved edit-book discard through the complete cancellation cleanup", async () => {
    const bookImport = read("dist/web/js/events/book-import.js");
    assert.match(bookImport, /registerUnsavedDialog\("edit-book-dialog", isEditBookDirty, \(\) => saveEditedBook\(\), \(\) => cancelEditBook\(\)\)/);

    let closeCount = 0;
    const els = {
      editBookTitle: { value: "" },
      editBookAuthor: { value: "" },
      editBookTags: { value: "" },
      editBookLevel: { value: "" },
      editBookText: { value: "", readOnly: false },
      editBookCoverImg: { src: "" },
      editBookCoverPreview: { hidden: true },
      editBookDialog: { showModal() {}, close() { closeCount += 1; } },
      editBookCancel: { disabled: false },
      editBookSave: { disabled: false }
    };
    const state = { customTexts: [{ id: "custom-1", title: "Title", text: "Body" }], userBooks: [] };
    const module = await evaluateWithMocks("dist/web/js/book-actions/edit-modal.js", {
      "../state.js": { state },
      "../dom.js": { els },
      "../toast.js": { showToast() {} },
      "../books.js": {
        bookTexts: new Map([["custom-1", "stale body"]]),
        findBookById() { return null; },
        async loadCustomTextContent() { return "fresh synced body"; }
      },
      "../vocab-index-client.js": { invalidateBookId() {} },
      "../utils.js": { formatTagList() { return ""; }, parseTagList() { return []; } },
      "../i18n.js": { t: (key) => key },
      "../views/library.js": { renderLibrary() {} },
      "../reader/renderer.js": { renderReader() {} },
      "../bridge-commit.js": { reloadBridgeSnapshot() {}, saveStateAndReloadBridge() {} },
      "../store-bridge.js": { upsertStoredText() {} }
    }, { window: { __qtBridge: false } });

    await module.openEditBookModal("custom-1");
    assert.equal(els.editBookText.value, "fresh synced body");
    module.setPendingEditCoverDataUrl("data:image/png;base64,test");
    assert.equal(module.isEditBookDirty(), true);

    module.cancelEditBook();

    assert.equal(module.pendingEditCoverDataUrl, null);
    assert.equal(module.isEditBookDirty(), false);
    assert.equal(els.editBookText.readOnly, false);
    assert.equal(closeCount, 1);
  });

  it("does not open a writable editor when the synced body refresh fails", async () => {
    let showCount = 0;
    const toasts = [];
    const els = {
      editBookTitle: { value: "" },
      editBookAuthor: { value: "" },
      editBookTags: { value: "" },
      editBookLevel: { value: "" },
      editBookText: { value: "stale body", readOnly: false },
      editBookCoverImg: { src: "" },
      editBookCoverPreview: { hidden: true },
      editBookDialog: { showModal() { showCount += 1; }, close() {} },
      editBookCancel: { disabled: false },
      editBookSave: { disabled: false }
    };
    const state = { customTexts: [{ id: "custom-1", title: "Title" }], userBooks: [] };
    const module = await evaluateWithMocks("dist/web/js/book-actions/edit-modal.js", {
      "../state.js": { state },
      "../dom.js": { els },
      "../toast.js": { showToast(message) { toasts.push(message); } },
      "../books.js": {
        bookTexts: new Map([["custom-1", "stale body"]]),
        findBookById() { return null; },
        async loadCustomTextContent() { throw new Error("refresh failed"); }
      },
      "../vocab-index-client.js": { invalidateBookId() {} },
      "../utils.js": { formatTagList() { return ""; }, parseTagList() { return []; } },
      "../i18n.js": { t: (key) => key },
      "../views/library.js": { renderLibrary() {} },
      "../reader/renderer.js": { renderReader() {} },
      "../bridge-commit.js": { reloadBridgeSnapshot() {}, saveStateAndReloadBridge() {} },
      "../store-bridge.js": { upsertStoredText() {} }
    }, { window: { __qtBridge: true }, console: { warn() {} } });

    await module.openEditBookModal("custom-1");

    assert.equal(showCount, 0);
    assert.deepEqual(toasts, ["toast.saveUnavailable"]);
    assert.equal(module.isEditBookDirty(), false);
  });

  it("locks move-book Cancel, select, and dialog cancellation until the move settles", async () => {
    const operation = deferred();
    const documentListeners = new Map();
    const dialog = eventTarget({
      closeCount: 0,
      showModal() {},
      close() { this.closeCount += 1; }
    });
    const select = eventTarget({ value: "fr", disabled: false, innerHTML: "" });
    const cancel = eventTarget({ disabled: false });
    const confirm = eventTarget({ disabled: false, click() { return this.dispatch("click"); } });
    class FakeElement {
      static [Symbol.hasInstance](value) { return value?.isElement === true; }
    }
    const document = {
      addEventListener(type, listener) { documentListeners.set(type, listener); },
      querySelector(selector) {
        return {
          "#move-book-dialog": dialog,
          "#move-book-select": select,
          "#move-book-cancel": cancel,
          "#move-book-confirm": confirm
        }[selector] || null;
      }
    };
    const module = await evaluateWithMocks("dist/web/js/events/move-book.js", {
      "../state.js": { state: { preferences: { learningLanguage: "de" } } },
      "../i18n.js": { t: (key) => key },
      "../book-actions.js": { moveBookToProfile() { return operation.promise; } },
      "../constants.js": { LEARNING_LANGUAGES: ["de", "fr"] }
    }, { document, Element: FakeElement });
    module.bindMoveBookEvents();
    documentListeners.get("click")({
      target: closestTarget({ "[data-action='move-book']": { dataset: { id: "book-1", iscustom: "true" } } }, { isElement: true })
    });

    const pending = confirm.dispatch("click");
    assert.equal(confirm.disabled, true);
    assert.equal(cancel.disabled, true);
    assert.equal(select.disabled, true);

    cancel.dispatch("click");
    assert.equal(dialog.closeCount, 0);
    let cancelPrevented = 0;
    dialog.dispatch("cancel", { preventDefault() { cancelPrevented += 1; } });
    assert.equal(cancelPrevented, 1);

    operation.resolve(true);
    await pending;
    assert.equal(dialog.closeCount, 1);
    assert.equal(confirm.disabled, false);
    assert.equal(cancel.disabled, false);
    assert.equal(select.disabled, false);
  });

  it("keeps Argos cancellation disabled and inert while installation is running", () => {
    const settings = read("dist/web/js/events/settings.js");
    assert.match(settings, /function cancelArgosDownload\(\) \{[\s\S]*?if \(argosDownloadRunning\)\s*return;[\s\S]*?argosDownloadDialog\)\s*els\.argosDownloadDialog\.close\(\)/);
    assert.match(settings, /argosDownloadRunning = true;[\s\S]*?argosDownloadCancel\)\s*els\.argosDownloadCancel\.disabled = true/);
    assert.match(settings, /finally \{[\s\S]*?argosDownloadRunning = false;[\s\S]*?argosDownloadCancel\)\s*els\.argosDownloadCancel\.disabled = false/);
  });

  it("disables inaccessible Translator navigation and rejects its click handler", async () => {
    const attributes = new Map();
    const nav = eventTarget({
      isElement: true,
      isButton: true,
      classList: classList(),
      dataset: { view: "translator" },
      disabled: false,
      hidden: true,
      title: "",
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; }
    });
    const state = {
      argosAvailable: false,
      argosModels: [],
      argosAvailablePackages: [],
      preferences: { learningLanguage: "de", locale: "en" },
      profiles: {}
    };
    const els = {
      translatorNavItem: nav,
      translatorFrom: { value: "de", innerHTML: "" },
      translatorTo: { value: "en", innerHTML: "" },
      translatorSource: { disabled: false },
      translatorResult: { disabled: false },
      translatorSwap: { disabled: false },
      translatorStatus: { dataset: {}, textContent: "" },
      translatorProgress: { classList: classList() }
    };
    class FakeButton {
      static [Symbol.hasInstance](value) { return value?.isButton === true; }
    }
    class FakeImage {
      static [Symbol.hasInstance]() { return false; }
    }
    const translator = await evaluateWithMocks("dist/web/js/views/translator.js", {
      "../dom.js": { els },
      "../i18n.js": { t: (key) => key },
      "../state.js": { state, saveState() {} },
      "../state/normalize.js": {
        normalizeSelectedWordPanelItems: (items) => items,
        rekeyActiveVocabForLocale() {}
      },
      "../toast.js": { showToast() {} },
      "../loading.js": { setElementBusy() {} },
      "../utils.js": { escapeHtml: (value) => String(value) },
      "../translation-provider.js": {
        activeTranslationProvider() { return "offline"; },
        canUseTranslationProvider() { return false; },
        translateText() { return Promise.resolve({ translated: "" }); },
        translateWithRetry() { return Promise.resolve({ translated: "" }); }
      },
      "../constants.js": { OTHER_PROFILE_ID: "other", TRANSLATOR_LANGUAGES: ["de", "en"] },
      "../translator-preferences.js": {
        normalizeTranslationLanguageCode: (value) => value,
        resolveProfileTranslationPair() { return { fromCode: "de", toCode: "en", configured: true }; }
      },
      "../ai-explainer.js": {
        aiExplanationConfigured: () => false,
        explainWord: async () => ({ explanation: "", cached: false }),
        formatAiExplanation: (text) => String(text ?? "")
      }
    }, {
      document: { getElementById() { return null; } },
      HTMLButtonElement: FakeButton,
      HTMLImageElement: FakeImage
    });

    translator.renderTranslator();
    assert.equal(nav.classList.contains("nav-item-locked"), true);
    assert.equal(nav.getAttribute("aria-disabled"), "true");
    assert.equal(nav.disabled, true);
    assert.equal(nav.hidden, false);

    let viewChanges = 0;
    class FakeElement {
      static [Symbol.hasInstance](value) { return value?.isElement === true; }
    }
    const navigationEls = { navItems: [nav], themeToggle: eventTarget(), reviewReverseToggle: null };
    const navigation = await evaluateWithMocks("dist/web/js/events/navigation.js", {
      "../state.js": { state, saveState() {} },
      "../dom.js": { els: navigationEls },
      "../render.js": { setView() { viewChanges += 1; } },
      "../preferences.js": { updatePreferenceValue() {}, applyPreferences() {}, themeLabel: (value) => value },
      "../views/vocabulary.js": { renderReview() {}, resetReviewPresentation() {} },
      "../toast.js": { showToast() {} },
      "../i18n.js": { t: (key) => key },
      "./keyboard/global-keys.js": { handleGlobalKeys() { return false; }, openReaderView() { viewChanges += 1; } },
      "./keyboard/reader-keys.js": { handleReaderKeys() { return false; } },
      "./keyboard/flashcards-keys.js": { handleFlashcardKeys() { return false; } },
      "../theme.js": { nextTheme: (value) => value, normalizeTheme: (value) => value }
    }, {
      document: { addEventListener() {}, getElementById() { return null; } },
      window: { matchMedia() { return { addEventListener() {} }; } },
      Element: FakeElement
    });
    navigation.bindNavigationEvents();
    nav.dispatch("click");
    assert.equal(viewChanges, 0);
  });

  it("renders image saves as buttons and keeps upload activation non-recursive", async () => {
    const container = { innerHTML: "" };
    const imageSearch = await evaluateWithMocks("dist/web/js/events/image-search.js", {
      "../state.js": { state: { preferences: {} } },
      "../i18n.js": { t: (key) => key },
      "../utils.js": { escapeAttribute: (value) => String(value) },
      "../translator-preferences.js": { effectiveLearningLanguage() { return "de"; } }
    }, {
      fetch: async () => ({
        json: async () => ({
          query: {
            pages: {
              one: { thumbnail: { source: "https://example.test/one.png" } },
              two: { thumbnail: { source: "https://example.test/two.png" } }
            }
          }
        })
      }),
      encodeURIComponent
    });
    imageSearch.renderImageSearch(container, "wort");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((container.innerHTML.match(/<button\b[^>]*data-action="save-image"/g) || []).length, 2);
    assert.doesNotMatch(container.innerHTML, /<div\b[^>]*data-action="save-image"/);
    assert.match(container.innerHTML, /role="button" tabindex="0"[^>]*data-action="upload-image"/);

    const { listeners } = await globalActionsHarness();
    const click = listeners.get("click");
    const keydown = listeners.get("keydown");
    let inputClicks = 0;
    const fileInput = closestTarget({ "[data-action='upload-image']": null }, {
      isInput: true,
      click() { inputClicks += 1; }
    });
    const upload = {
      querySelector(selector) { return selector === 'input[type="file"]' ? fileInput : null; }
    };
    click({ target: closestTarget({ "[data-action='upload-image']": upload }), composedPath() { return []; } });
    assert.equal(inputClicks, 1);
    fileInput.closest = (selector) => selector === "[data-action='upload-image']" ? upload : null;
    click({ target: fileInput, composedPath() { return []; } });
    assert.equal(inputClicks, 1);

    let uploadActivations = 0;
    const action = { click() { uploadActivations += 1; } };
    for (const key of ["Enter", " "]) {
      let prevented = 0;
      keydown({
        key,
        target: closestTarget({ '[role="button"][data-action]': action }),
        preventDefault() { prevented += 1; }
      });
      assert.equal(prevented, 1);
    }
    assert.equal(uploadActivations, 2);
  });

  it("restores selected-word settings focus after visibility and reorder renders", () => {
    const settings = read("dist/web/js/events/settings.js");
    assert.match(settings, /preferred && !preferred\.disabled/);
    assert.match(settings, /fallback && !fallback\.disabled \? fallback : checkbox/);
    assert.match(settings, /item\.visible = input\.checked;\s*saveSelectedWordPanelItems\(items\);\s*restoreSelectedWordPanelSettingFocus\(id\)/);
    assert.match(settings, /\[items\[index\], items\[nextIndex\]\] = \[items\[nextIndex\], items\[index\]\];\s*saveSelectedWordPanelItems\(items\);\s*restoreSelectedWordPanelSettingFocus\(id, button\.dataset\.direction\)/);
  });

  it("routes the new desktop Reader shortcuts and leaves Android untouched", async () => {
    const calls = [];
    const state = {
      selectedWord: "middle",
      selectedWordIndex: 1,
      readerSelectionRange: null,
      preferences: { readerWordPanelVisible: true }
    };
    let android = false;
    class FakeElement {
      static [Symbol.hasInstance](value) { return value !== null && typeof value === "object"; }
    }
    class FakeButton {
      static [Symbol.hasInstance](value) { return value?.isButton === true; }
    }
    const document = {
      activeElement: null,
      body: { contains() { return true; } },
      getElementById(id) { return elements[id] || null; },
      querySelector() { return null; }
    };
    const token = (name, index) => ({
      isButton: true,
      dataset: { word: name, wordIndex: String(index) },
      classList: classList(["word-token"]),
      focus() { document.activeElement = this; calls.push(["focus", name]); }
    });
    const tokens = [token("first", 0), token("middle", 1), token("last", 2)];
    const play = { hidden: false, disabled: false, click() { calls.push(["tts", "play"]); } };
    const stop = { hidden: true, disabled: false, click() { calls.push(["tts", "stop"]); } };
    const panel = {
      contains(value) { return value?.insidePanel === true; },
      focus() { document.activeElement = this; calls.push(["focus", "panel"]); }
    };
    const elements = { "tts-play-text": play, "tts-stop-text": stop, "word-panel": panel };
    document.activeElement = tokens[1];

    const module = await evaluateWithMocks("dist/web/js/events/keyboard/reader-keys.js", {
      "../../state.js": { state },
      "../../i18n.js": { t: (key) => key },
      "../../toast.js": { showToast() {} },
      "../../dialog-backdrop.js": { showConfirmDialog: async () => true },
      "../../reader/selection.js": { clearReaderSelection() {}, extendReaderSelection() { return false; } },
      "../../tts.js": { speakWord() {} },
      "../../vocab-actions.js": { setWordStatus() {} },
      "../shared.js": {
        openDictionary() {}, getSelectedReaderActionText() { return "middle"; },
        copySelectedWordToClipboard() {}, hasNativeTextSelection() { return false; }
      },
      "../../youglish.js": { openYouGlish() {} },
      "../../reader/word-navigation.js": {
        findCurrentReaderToken() { return tokens[1]; },
        navigateReaderWord() {},
        readerTokens() { return tokens; },
        selectReaderToken(selected) { calls.push(["select", selected]); return true; }
      },
      "../../reader/bookmarks.js": {
        toggleReaderBookmarkAtCurrentWord(wordIndex) { calls.push(["bookmark", wordIndex]); return true; }
      },
      "../../platform.js": { isAndroidPlatform() { return android; } }
    }, {
      document,
      window: {},
      CSS: { escape: (value) => value },
      HTMLElement: FakeElement,
      HTMLButtonElement: FakeButton,
      HTMLSelectElement: FakeElement
    });
    const keyboardEvent = (overrides = {}) => ({
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, code: "",
      prevented: false, preventDefault() { this.prevented = true; }, ...overrides
    });

    const startTts = keyboardEvent({ shiftKey: true, code: "Space" });
    assert.equal(module.handleReaderKeys(startTts, " "), true);
    assert.equal(startTts.prevented, true);
    stop.hidden = false;
    const stopTts = keyboardEvent({ shiftKey: true, code: "Space" });
    assert.equal(module.handleReaderKeys(stopTts, " "), true);
    assert.equal(module.handleReaderKeys(keyboardEvent(), "b"), true);

    assert.equal(module.handleReaderKeys(keyboardEvent(), "f6"), true);
    assert.equal(document.activeElement, panel);
    assert.equal(module.handleReaderKeys(keyboardEvent(), "f6"), true);
    assert.equal(document.activeElement, tokens[1]);

    assert.equal(module.handleReaderKeys(keyboardEvent({ ctrlKey: true }), "home"), true);
    assert.equal(module.handleReaderKeys(keyboardEvent({ ctrlKey: true }), "end"), true);
    assert.deepEqual(calls.filter(([type]) => type === "tts"), [["tts", "play"], ["tts", "stop"]]);
    assert.deepEqual(calls.find(([type]) => type === "bookmark"), ["bookmark", 1]);
    assert.deepEqual(calls.filter(([type]) => type === "select").map(([, selected]) => selected), [tokens[0], tokens[2]]);

    const callsBeforeAndroid = calls.length;
    android = true;
    for (const [key, event] of [
      [" ", keyboardEvent({ shiftKey: true, code: "Space" })],
      ["b", keyboardEvent()],
      ["f6", keyboardEvent()],
      ["home", keyboardEvent({ ctrlKey: true })],
      ["end", keyboardEvent({ ctrlKey: true })]
    ]) {
      assert.equal(module.handleReaderKeys(event, key), false, key);
      assert.equal(event.prevented, false, key);
    }
    assert.equal(calls.length, callsBeforeAndroid);
  });

  it("ignores hidden E/N fields and never focuses matching controls outside the word panel", async () => {
    const state = { selectedWord: "wort", readerSelectionRange: null };
    const outside = { focusCount: 0, focus() { this.focusCount += 1; } };
    const panelField = {
      focusCount: 0,
      selectCount: 0,
      focus() { this.focusCount += 1; },
      select() { this.selectCount += 1; }
    };
    let panelVisible = false;
    const selectors = [];
    const document = {
      activeElement: null,
      body: { contains() { return false; } },
      querySelector(selector) {
        selectors.push(selector);
        if (selector.startsWith("#word-panel [data-word-field=") && panelVisible) return panelField;
        if (selector.startsWith("[data-word-field=")) return outside;
        return null;
      },
      getElementById() { return null; }
    };
    class NeverElement {
      static [Symbol.hasInstance]() { return false; }
    }
    const module = await evaluateWithMocks("dist/web/js/events/keyboard/reader-keys.js", {
      "../../state.js": { state },
      "../../i18n.js": { t: (key) => key },
      "../../toast.js": { showToast() {} },
      "../../dialog-backdrop.js": { showConfirmDialog: async () => true },
      "../../reader/selection.js": { clearReaderSelection() {}, extendReaderSelection() { return false; } },
      "../../tts.js": { speakWord() {} },
      "../../vocab-actions.js": { setWordStatus() {} },
      "../shared.js": {
        openDictionary() {}, getSelectedReaderActionText() { return "wort"; },
        copySelectedWordToClipboard() {}, hasNativeTextSelection() { return false; }
      },
      "../../youglish.js": { openYouGlish() {} },
      "../../reader/word-navigation.js": {
        findCurrentReaderToken() { return null; }, navigateReaderWord() {}, readerTokens() { return []; }, selectReaderToken() {}
      },
      "../../reader/bookmarks.js": { toggleReaderBookmarkAtCurrentWord() { return false; } },
      "../../platform.js": { isAndroidPlatform() { return false; } }
    }, {
      document,
      window: {},
      CSS: { escape: (value) => value },
      HTMLElement: NeverElement,
      HTMLButtonElement: NeverElement,
      HTMLSelectElement: NeverElement
    });
    const keyEvent = () => ({
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, code: "",
      prevented: false, preventDefault() { this.prevented = true; }
    });

    for (const key of ["e", "n"]) {
      const event = keyEvent();
      assert.equal(module.handleReaderKeys(event, key), false);
      assert.equal(event.prevented, false);
    }
    assert.equal(outside.focusCount, 0);
    const fieldSelectors = selectors.filter((selector) => selector.includes("[data-word-field="));
    assert.equal(fieldSelectors.length, 2);
    assert.ok(fieldSelectors.every((selector) => selector.startsWith("#word-panel ")));

    panelVisible = true;
    const event = keyEvent();
    assert.equal(module.handleReaderKeys(event, "e"), true);
    assert.equal(event.prevented, true);
    assert.equal(panelField.focusCount, 1);
    assert.equal(panelField.selectCount, 1);
  });

  it("omits Edit and Remove actions for transient Reader ranges", async () => {
    const state = {
      selectedWord: "two words",
      selectedWordIndex: 0,
      vocab: {},
      preferences: {
        selectedWordPanelItems: [
          { id: "dictionary", visible: true },
          { id: "edit", visible: true },
          { id: "remove", visible: true }
        ]
      }
    };
    const wordPanel = { innerHTML: "", querySelector() { return null; }, querySelectorAll() { return []; } };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getReaderSelectionText() { return "two words"; },
      getSentenceForWord() { return ""; }
    });

    module.renderWordPanel({ id: "text-1", text: "two words" });

    assert.match(wordPanel.innerHTML, /data-word-panel-item="dictionary"/);
    assert.doesNotMatch(wordPanel.innerHTML, /data-word-panel-item="edit"|data-edit-word/);
    assert.doesNotMatch(wordPanel.innerHTML, /data-word-panel-item="remove"|data-delete-word/);
  });

  it("invalidates stale context translations after the panel is rerendered", async () => {
    const translation = deferred();
    const panels = [];
    let releaseCount = 0;
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
        panels.push(this.current);
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-translate-context]") return this.current?.button || null;
        if (selector === "[data-context-translation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "wort",
      selectedWordIndex: 0,
      vocab: { wort: { status: "new", translation: "", note: "", examples: ["Context sentence."] } },
      preferences: { selectedWordPanelItems: [{ id: "context", visible: true }] }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getReaderSelectionText() { return ""; },
      getSentenceForWord() { return "Context sentence."; },
      translateText() { return translation.promise; },
      beginElementBusy() { return () => { releaseCount += 1; }; }
    });

    module.renderWordPanel({ id: "text-1", text: "Context sentence." });
    const detached = panels.at(-1);
    const pending = detached.button.dispatch("click", { stopPropagation() {} });
    assert.equal(detached.output.textContent, "translator.translating");

    module.renderWordPanel({ id: "text-1", text: "Context sentence." });
    translation.resolve({ translated: "Detached result" });
    await pending;

    assert.equal(detached.output.innerHTML, "");
    assert.equal(releaseCount, 1);
    assert.notStrictEqual(panels.at(-1), detached);
  });

  it("appends a finished AI explanation to the word note through updateWordField", async () => {
    const writes = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "", examples: ["Ich komme an."] } },
      preferences: { selectedWordPanelItems: [{ id: "ai", visible: true }] }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => ({ explanation: "To jest **bold** i *kursywa*.", cached: false }),
      updateWordField: (word, field, value) => {
        writes.push([word, field, value]);
        state.vocab[word][field] = value;
      }
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });

    wordPanel.current.button.dispatch("click", { stopPropagation() {} });
    await flushAsync();

    assert.equal(
      wordPanel.current.output.innerHTML,
      "To jest **bold** i *kursywa*.",
      "the inline output still renders the explanation"
    );
    assert.deepEqual(writes, [["an", "note", "reader.aiNoteMarker:\nTo jest **bold** i *kursywa*."]]);

    // A second identical explanation is not appended twice
    writes.length = 0;
    wordPanel.current.button.dispatch("click", { stopPropagation() {} });
    await flushAsync();
    assert.deepEqual(writes, [], "identical explanations must not duplicate the note");
  });

  it("preserves an existing user note and appends the AI explanation to it", async () => {
    const writes = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "Moja własna notatka o tym słowie.", examples: ["Ich komme an."] } },
      preferences: { selectedWordPanelItems: [{ id: "ai", visible: true }] }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => ({ explanation: "Wyjaśnienie.", cached: false }),
      updateWordField: (word, field, value) => {
        writes.push([word, field, value]);
        state.vocab[word][field] = value;
      }
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });

    wordPanel.current.button.dispatch("click", { stopPropagation() {} });
    await flushAsync();

    assert.deepEqual(
      writes,
      [["an", "note", "Moja własna notatka o tym słowie.\n\nreader.aiNoteMarker:\nWyjaśnienie."]],
      "the existing note must be preserved and the explanation appended after it"
    );
  });

  it("does not persist AI explanations for transient phrase ranges", async () => {
    const writes = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "kommen an",
      selectedWordIndex: 0,
      vocab: {},
      preferences: { selectedWordPanelItems: [{ id: "ai", visible: true }] }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getReaderSelectionText() { return "kommen an"; },
      getSentenceForWord() { return "Wir kommen an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => ({ explanation: "Wyjaśnienie frazy.", cached: false }),
      updateWordField: (word, field, value) => writes.push([word, field, value])
    });
    module.renderWordPanel({ id: "text-1", text: "Wir kommen an." });

    wordPanel.current.button.dispatch("click", { stopPropagation() {} });
    await flushAsync();

    assert.equal(wordPanel.current.output.innerHTML, "Wyjaśnienie frazy.", "inline output still shows the explanation");
    assert.deepEqual(writes, [], "transient ranges must not create dictionary entries");
  });

  it("auto-triggers an AI explanation for a word that never had one", async () => {
    const calls = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "", examples: ["Ich komme an."] } },
      preferences: {
        selectedWordPanelItems: [{ id: "ai", visible: true }],
        aiExplanationAutoTrigger: true
      }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => {
        calls.push("explain");
        return { explanation: "Auto wyjaśnienie.", cached: false };
      },
      hasWordExplanation: (word) => calls.some((c) => c === "explain" && word === "an"),
      markWordExplained: (word) => calls.push(`marked:${word}`),
      updateWordField: (word, field, value) => {
        calls.push(`write:${field}`);
        state.vocab[word][field] = value;
      }
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    await flushAsync();

    assert.ok(calls.includes("explain"), "the explanation must be requested automatically");
    assert.ok(calls.includes("write:note"), "the note append must run");
    assert.equal(state.vocab.an.note, "reader.aiNoteMarker:\nAuto wyjaśnienie.");
    assert.ok(calls.includes("marked:an"), "the word must be remembered as explained");
  });

  it("does not auto-trigger when the setting is off", async () => {
    const calls = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "", examples: ["Ich komme an."] } },
      preferences: {
        selectedWordPanelItems: [{ id: "ai", visible: true }],
        aiExplanationAutoTrigger: false
      }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => { calls.push("explain"); return { explanation: "x", cached: false }; },
      updateWordField: (word, field, value) => calls.push(`write:${field}`)
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    await flushAsync();

    assert.deepEqual(calls, [], "no automatic explanation without the setting");
  });

  it("does not auto-trigger for a word that already has an explanation", async () => {
    const calls = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        const button = eventTarget();
        const output = { hidden: true, textContent: "", innerHTML: "" };
        this.current = { button, output };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "już było", examples: ["Ich komme an."] } },
      preferences: {
        selectedWordPanelItems: [{ id: "ai", visible: true }],
        aiExplanationAutoTrigger: true
      }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => { calls.push("explain"); return { explanation: "x", cached: false }; },
      hasWordExplanation: () => true,
      updateWordField: (word, field, value) => calls.push(`write:${field}`)
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    await flushAsync();

    assert.deepEqual(calls, [], "an already-explained word must not be auto-explained again");
  });

  it("does not auto-trigger while an explanation is already in flight (panel re-render)", async () => {
    const calls = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        this.current = { button: eventTarget(), output: { hidden: true, textContent: "", innerHTML: "" } };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: { an: { status: "new", translation: "", note: "", examples: ["Ich komme an."] } },
      preferences: {
        selectedWordPanelItems: [{ id: "ai", visible: true }],
        aiExplanationAutoTrigger: true
      }
    };
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "Ich komme an."; },
      aiExplanationConfigured: () => true,
      explainWord: async () => { calls.push("explain"); await gate; return { explanation: "x", cached: false }; },
      hasWordExplanation: () => false,
      updateWordField: (word, field, value) => calls.push(`write:${field}`)
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    // The first render auto-triggers; a re-render while it is pending must not
    // start a second request.
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    await flushAsync();
    assert.equal(calls.filter((call) => call === "explain").length, 1, "exactly one explain request while in flight");
    releaseFirst();
    await flushAsync();
    assert.deepEqual(calls, ["explain", "write:note"], "the pending explanation still completes and persists");
  });

  it("never auto-triggers for transient phrase ranges", async () => {
    const calls = [];
    const wordPanel = {
      rendered: "",
      current: null,
      set innerHTML(value) {
        this.rendered = value;
        this.current = { button: eventTarget(), output: { hidden: true, textContent: "", innerHTML: "" } };
      },
      get innerHTML() { return this.rendered; },
      querySelector(selector) {
        if (selector === "[data-ai-explain]") return this.current?.button || null;
        if (selector === "[data-ai-explanation]") return this.current?.output || null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    const state = {
      selectedWord: "an",
      selectedWordIndex: 0,
      vocab: {},
      preferences: {
        selectedWordPanelItems: [{ id: "ai", visible: true }],
        aiExplanationAutoTrigger: true
      }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getSentenceForWord() { return "komme an"; },
      getReaderSelectionText() { return "komme an"; },
      aiExplanationConfigured: () => true,
      explainWord: async () => { calls.push("explain"); return { explanation: "x", cached: false }; },
      hasWordExplanation: () => false,
      updateWordField: (word, field, value) => calls.push(`write:${field}`)
    });
    module.renderWordPanel({ id: "text-1", text: "Ich komme an." });
    await flushAsync();
    assert.deepEqual(calls, [], "transient phrase ranges must never auto-trigger an AI explanation");
  });

  it("retires the in-text review explanation after three completed guesses", async () => {
    let html = "";
    let answerButton = null;
    let gradeButtons = [];
    let saves = 0;
    const review = {};
    const rebuildControls = () => {
      answerButton = html.includes("data-in-text-answer") ? eventTarget() : null;
      gradeButtons = [...html.matchAll(/data-in-text-grade="(\d)"/g)].map((match) => eventTarget({ dataset: { inTextGrade: match[1] } }));
    };
    Object.defineProperty(review, "outerHTML", {
      set(value) { html = value; rebuildControls(); }
    });
    const wordPanel = {
      dataset: {},
      classList: classList(),
      parentElement: { classList: classList() },
      set innerHTML(value) { html = value; rebuildControls(); },
      get innerHTML() { return html; },
      querySelector(selector) {
        if (selector === ".in-text-review") return html.includes("in-text-review") ? review : null;
        if (selector === "[data-in-text-answer]") return answerButton;
        return null;
      },
      querySelectorAll(selector) { return selector === "[data-in-text-grade]" ? gradeButtons : []; }
    };
    const state = {
      selectedWord: "wort",
      selectedWordIndex: 0,
      readerSelectionRange: null,
      vocab: {
        wort: { status: "learning", translation: "word", examples: [] },
        neu: { status: "learning", translation: "new", examples: [] }
      },
      preferences: {
        inTextReview: true,
        inTextReviewCompletedGuesses: 2,
        selectedWordPanelItems: [{ id: "translation", visible: true }]
      }
    };
    const module = await evaluateWordPanel({
      state,
      wordPanel,
      getReaderSelectionText() { return ""; },
      getSentenceForWord() { return ""; },
      isInTextReviewDue() { return true; },
      async applyReviewGrade(word) { return state.vocab[word]; },
      saveState() { saves += 1; }
    });

    module.renderWordPanel({ id: "text-1", text: "" });
    assert.match(html, /sm2\.inTextPrompt/);
    answerButton.dispatch("click", { stopPropagation() {} });
    await gradeButtons[0].dispatch("click", { stopPropagation() {} });
    assert.equal(state.preferences.inTextReviewCompletedGuesses, 3);
    assert.equal(saves, 1);

    state.selectedWord = "neu";
    module.renderWordPanel({ id: "text-1", text: "" });
    assert.doesNotMatch(html, /sm2\.inTextPrompt/);
    assert.match(html, /data-in-text-answer/);
    assert.match(html, /sm2\.showAnswer/);
  });

  it("keeps popup language metadata localized through template placeholders", () => {
    const popup = read("dist/web/templates/translator-popup.html");
    const popupRuntime = read("dist/web/translator-popup.js");
    const backend = read("src-tauri/src/offline_translator/translator/ui.rs");

    assert.match(popup, /<html lang="\{\{locale\}\}"/);
    assert.match(popup, /id="flag-from"[^>]*\/flags\/\{\{from_code\}\}\.svg[^>]*alt=""/);
    assert.match(popup, /id="flag-to"[^>]*\/flags\/\{\{to_code\}\}\.svg[^>]*alt=""/);
    assert.match(popup, /id="from-lang" title="\{\{from_label\}\}" aria-label="\{\{from_label\}\}"/);
    assert.match(popup, /id="to-lang" title="\{\{to_label\}\}" aria-label="\{\{to_label\}\}"/);
    assert.doesNotMatch(popup, /(?:alt|title|aria-label)="(?:Source|Target) language(?: flag)?"/i);
    assert.match(backend, /\("\{\{locale\}\}", escape_attr\(&locale\)\)/);
    assert.match(backend, /"\{\{from_label\}\}"[\s\S]*labels\.get\("from"\)/);
    assert.match(backend, /"\{\{to_label\}\}"[\s\S]*labels\.get\("to"\)/);
    assert.match(popupRuntime, /translationController\?\.abort\(\)/);
    assert.match(popupRuntime, /function invalidateTranslation\(\)/);
    assert.match(popupRuntime, /addEventListener\("input", \(\) => \{[\s\S]*invalidateTranslation\(\);[\s\S]*setTimeout\(translate, 300\)/);
    assert.match(popupRuntime, /addEventListener\("change", \(\) => \{[\s\S]*clearTimeout\(timer\);[\s\S]*translate\(\)/);
    assert.match(popupRuntime, /generation !== activeTranslation/);
    assert.match(popupRuntime, /generation === activeTranslation/);
  });
});

async function evaluateWordPanel({
  state,
  wordPanel,
  getReaderSelectionText = () => "",
  getReaderWordTokens = () => [],
  getSentenceForWord,
  translateText = async () => ({ translated: "" }),
  beginElementBusy = () => () => {},
  applyReviewGrade = () => null,
  isInTextReviewDue = () => false,
  saveState = () => {},
  aiExplanationConfigured = () => false,
  explainWord = async () => ({ explanation: "", cached: false }),
  hasWordExplanation = () => false,
  markWordExplained = () => {},
  updateWordField = () => {}
}) {
  return evaluateWithMocks("dist/web/js/reader/word-panel.js", {
    "../state.js": { state, saveState, getVocabularyRevision: () => 0 },
    "./session.js": {
      getReaderSession: () => ({ id: null, text: "", tokens: [], stats: { unique: 0 }, classifications: {} }),
      analyzeReaderSession: (session) => { session.stats = { unique: 0 }; return session; }
    },
    "../dom.js": { els: { wordPanel, readerText: null, uniqueSummary: null } },
    "../utils.js": {
      escapeHtml: (value) => String(value ?? ""),
      escapeAttribute: (value) => String(value ?? ""),
      statusLabel: (status) => status
    },
    "../icons.js": { icon: () => "", statusIcon: () => "" },
    "../tokenizer_v2.js": { getSentenceForWord, getTextStats() { return { unique: 0 }; } },
    "../constants.js": {
      IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3,
      STATUS_ORDER: ["new", "learning", "known", "ignored"]
    },
    "../i18n.js": { t: (key) => key },
    "../views/vocabulary.js": {
      getOrCreateEntry(word) {
        return state.vocab[word] || { status: "new", translation: "", note: "", imageUrl: "", examples: [] };
      }
    },
    "../vocab-actions.js": { updateWordField },
    "./renderer.js": { getTextById() { return null; }, renderTrackingSummary() {} },
    "./selection.js": { getReaderSelectionText, getReaderWordTokens },
    "./smart-suggest.js": {
      articleOptionsForLanguage() { return []; },
      getSmartSuggestion() { return null; },
      getSmartSuggestionHtml() { return ""; },
      renderSmartSuggestionHtml() { return ""; },
      supportsArticleLanguage() { return false; }
    },
    "../vocabulary/article.js": {
      formatHeadword(word, article) { return article ? (article.endsWith("'") || article.endsWith("’") ? `${article}${word}` : `${article} ${word}`) : word; }
    },
    "../vocabulary/review-card.js": { applyReviewGrade },
    "../reader-colors.js": { getLearningColor() { return ""; } },
    "../sm2.js": { isInTextReviewDue },
    "../translation-provider.js": { canUseTranslationProvider() { return true; }, translateText, translateWithRetry: translateText },
    "../loading.js": { beginElementBusy },
    "../translator-preferences.js": {
      effectiveLearningLanguage() { return "de"; },
      resolveProfileTranslationPair() { return { fromCode: "de", toCode: "en" }; }
    },
    "../state/normalize.js": { normalizeSelectedWordPanelItems: (items) => items },
    "../ai-explainer.js": {
      aiExplanationConfigured,
      aiExplanationLanguagePair: () => ({ from: "de", to: "en" }),
      collectPdfOcrImageContext: async () => null,
      formatAiExplanation: (text) => String(text ?? ""),
      explainWord,
      hasWordExplanation,
      markWordExplained
    },
    "../status-sounds.js": { playReviewGradeSound() {} }
  }, {
    document: { querySelector() { return null; } },
    window: {},
    CSS: { escape: (value) => String(value) }
  });
}
