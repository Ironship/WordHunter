import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function source(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function fakeEventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) || [])]) {
        listener.call(this, { type, target: this, ...event });
      }
    }
  }, extra);
}

async function evaluateWithMocks(file, importValues, globals = {}, dynamicImportValues = {}) {
  const context = vm.createContext(globals);
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
  const module = new vm.SourceTextModule(source(file.replace("../../", "")), {
    context,
    identifier: new URL(file, import.meta.url).href,
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

describe("render performance guards", () => {
  it("keeps a Reader token above the open Pocket word sheet", async () => {
    const scrolls = [];
    const container = {
      clientHeight: 500,
      scrollHeight: 1500,
      scrollTop: 100,
      contains: (element) => element === token,
      getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
      scrollTo(options) {
        scrolls.push(options);
        this.scrollTop = options.top;
      }
    };
    const token = {
      closest: () => container,
      getBoundingClientRect: () => ({ top: 450, bottom: 470, height: 20 })
    };
    const panel = { getBoundingClientRect: () => ({ top: 400, bottom: 700, height: 300 }) };
    const classes = new Set(["pocket-mode", "pocket-word-panel-open"]);
    const document = {
      documentElement: { classList: { contains: (name) => classes.has(name) } },
      getElementById: () => container,
      querySelector: () => panel
    };
    const { keepReaderTokenVisible } = await evaluateWithMocks("../../dist/web/js/reader/visibility.js", {}, { document });

    assert.equal(keepReaderTokenVisible(token), true);
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].top, 310);
    assert.equal(scrolls[0].behavior, "auto");

    token.getBoundingClientRect = () => ({ top: 220, bottom: 240, height: 20 });
    assert.equal(keepReaderTokenVisible(token), false);
    assert.equal(scrolls.length, 1);
  });

  it("persists imprecise reader scrolls without hit-testing the document", async () => {
    let elementFromPointCalls = 0;
    let persistedWrites = 0;
    let flushes = 0;
    const readerScrolls = new Proxy({}, {
      set(target, key, value) {
        persistedWrites++;
        target[key] = value;
        return true;
      }
    });
    const readerScrollsPerPage = new Proxy({}, {
      set(target, key, value) {
        persistedWrites++;
        target[key] = value;
        return true;
      }
    });
    const state = {
      currentTextId: "text-1",
      readerPage: 3,
      readerScrolls,
      readerScrollsPerPage
    };
    const readerText = {
      scrollTop: 127.6,
      getBoundingClientRect() {
        throw new Error("layout measurement should not run for an imprecise save");
      }
    };
    const document = {
      elementFromPoint() {
        elementFromPointCalls++;
        throw new Error("elementFromPoint should not run for an imprecise save");
      }
    };
    const { rememberReaderScrollPosition } = await evaluateWithMocks("../../dist/web/js/reader/scroll.js", {
      "../state.js": { state, saveUiState: () => { flushes++; } },
      "../dom.js": { els: { readerText } }
    }, { document, setTimeout });

    rememberReaderScrollPosition({ precise: false, flush: true });

    assert.equal(elementFromPointCalls, 0);
    assert.equal(readerScrolls["text-1"].wordIndex, null);
    assert.equal(readerScrolls["text-1"].scrollTop, 128);
    assert.equal(readerScrolls["text-1"].readerPage, 3);
    assert.equal(readerScrollsPerPage["text-1-p3"], 128);
    assert.equal(persistedWrites, 2);
    assert.equal(flushes, 1);
  });

  it("falls back to a visible token when fixed viewport probes miss the text", async () => {
    const state = { currentTextId: "text-1", readerPage: 3, readerScrolls: {}, readerScrollsPerPage: {} };
    const visibleToken = {
      dataset: { wordIndex: "269" },
      getBoundingClientRect: () => ({ left: 120, right: 190, top: 140, bottom: 165, height: 25 })
    };
    const horizontallyHiddenToken = {
      dataset: { wordIndex: "12" },
      getBoundingClientRect: () => ({ left: -220, right: -120, top: 140, bottom: 165, height: 25 })
    };
    const readerText = {
      scrollTop: 1200,
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 100, bottom: 500, width: 800, height: 400 }),
      querySelectorAll: () => [horizontallyHiddenToken, visibleToken],
      contains: () => true
    };
    class HTMLElement {
      static [Symbol.hasInstance](value) { return value !== null && typeof value === "object"; }
    }
    const { rememberReaderScrollPosition } = await evaluateWithMocks("../../dist/web/js/reader/scroll.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: { readerText } }
    }, {
      HTMLElement,
      document: { elementFromPoint: () => null }
    });

    rememberReaderScrollPosition({ precise: true });

    assert.equal(state.readerScrolls["text-1"].wordIndex, 269);
    assert.equal(state.readerScrolls["text-1"].scrollTop, 1200);
    assert.equal(state.readerScrolls["text-1"].readerPage, 3);
  });

  it("restores the exact saved word before stale per-page pixels", async () => {
    const state = {
      currentTextId: "text-1",
      readerPage: 3,
      readerScrollsPerPage: { "text-1-p3": 999, "text-1-p2": 333 }
    };
    const token = { getBoundingClientRect: () => ({ top: 800, height: 20 }) };
    const readerText = {
      scrollTop: 10,
      scrollHeight: 2000,
      clientHeight: 400,
      dataset: {},
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: (selector) => selector.includes('data-word-index="42"') ? token : null
    };
    const { restoreReaderPagePosition } = await evaluateWithMocks("../../dist/web/js/reader/scroll.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: { readerText } }
    }, { setTimeout });

    restoreReaderPagePosition("text-1", "text-1-p3", { readerPage: 3, wordIndex: 42, scrollTop: 120 });
    assert.equal(readerText.scrollTop, 520);

    token.getBoundingClientRect = () => ({ top: 290, height: 20 });
    readerText.scrollTop = 0;
    restoreReaderPagePosition("text-1", "text-1-p3", { readerPage: 3, wordIndex: 42, scrollTop: 120 });
    assert.equal(readerText.scrollTop, 0);

    state.readerPage = 2;
    restoreReaderPagePosition("text-1", "text-1-p2", { readerPage: 3, wordIndex: 42, scrollTop: 120 });
    assert.equal(readerText.scrollTop, 333);
  });

  it("does not apply a delayed scroll retry after the reader changes page", async () => {
    const state = { currentTextId: "text-1", readerPage: 3, readerScrollsPerPage: {} };
    const readerText = {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 400,
      dataset: {},
      querySelector: () => null
    };
    let retry = null;
    const { restoreReaderPagePosition } = await evaluateWithMocks("../../dist/web/js/reader/scroll.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: { readerText } }
    }, { setTimeout: (callback) => { retry = callback; return 1; } });

    restoreReaderPagePosition("text-1", "text-1-p3", { readerPage: 3, wordIndex: 42, scrollTop: 120 });
    assert.equal(typeof retry, "function");
    state.readerPage = 4;
    readerText.scrollHeight = 2000;
    retry();
    assert.equal(readerText.scrollTop, 0);
  });

  it("does not apply an old delayed retry after a new same-page restore", async () => {
    const state = { currentTextId: "text-1", readerPage: 3, readerScrollsPerPage: {} };
    const readerText = {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 400,
      dataset: {},
      querySelector: () => null
    };
    let oldRetry = null;
    const { restoreReaderPagePosition } = await evaluateWithMocks("../../dist/web/js/reader/scroll.js", {
      "../state.js": { state, saveUiState() {} },
      "../dom.js": { els: { readerText } }
    }, { setTimeout: (callback) => { oldRetry = callback; return 1; } });

    restoreReaderPagePosition("text-1", "text-1-p3", { readerPage: 3, wordIndex: 42, scrollTop: 120 });
    assert.equal(typeof oldRetry, "function");
    readerText.scrollHeight = 2000;
    restoreReaderPagePosition("text-1", "text-1-p3", { readerPage: 3, wordIndex: 87, scrollTop: 640 });
    assert.equal(readerText.scrollTop, 640);
    oldRetry();
    assert.equal(readerText.scrollTop, 640);
  });

  it("captures an exact word position on routine reader scroll events", async () => {
    const pendingTimers = new Map();
    const rememberCalls = [];
    const articleUpdates = [];
    let wordPanelRenders = 0;
    let nextTimerId = 1;
    let frontendFlusher;
    const setTimeout = (callback, delay) => {
      const id = nextTimerId++;
      pendingTimers.set(id, { callback, delay });
      return id;
    };
    const clearTimeout = (id) => pendingTimers.delete(id);
    const takeTimer = () => {
      const next = pendingTimers.entries().next().value;
      assert.ok(next, "expected a reader scroll timer");
      const [id, timer] = next;
      pendingTimers.delete(id);
      return timer;
    };
    const readerText = fakeEventTarget({
      dataset: { rendering: "0" },
      scrollTop: 101,
      querySelector() { return null; }
    });
    const els = {
      readerSidebarResizer: null,
      readerText,
      textSelect: fakeEventTarget({ value: "" }),
      wordPanel: fakeEventTarget({ querySelector: () => null })
    };
    const state = {
      currentTextId: "text-1",
      currentView: "reader",
      readerPage: 2,
      readerScrolls: { "text-1": { readerPage: 2, scrollTop: 100 } },
      selectedWord: "das"
    };
    const noOp = () => {};
    class FakeElement {}
    class FakeHtmlElement {
      static [Symbol.hasInstance](value) {
        return value !== null && typeof value === "object";
      }
    }
    const { bindReaderEvents } = await evaluateWithMocks("../../dist/web/js/views/reader.js", {
      "../panel-resizer.js": { bindSidebarResizer: noOp },
      "../state.js": {
        registerFrontendStateFlusher(callback) { frontendFlusher = callback; },
        state
      },
      "../reader/selection.js": {
        setReaderSelectionAnchorFromToken: noOp,
        clearReaderSelectionRange: noOp,
        clearReaderSelection: noOp
      },
      "../reader/scroll.js": {
        rememberReaderScrollPosition(options) { rememberCalls.push(options); }
      },
      "../reader/bookmarks.js": { bindReaderBookmarkEvents: noOp },
      "../platform.js": { refreshPocketWordPanelSheet: noOp },
      "../reader/word-navigation.js": { navigateReaderWord: noOp },
      "../reader/renderer.js": {
        changeReaderPage: noOp,
        getTextById() { return { id: "text-1", text: "Das Haus ist alt." }; },
        goToReaderPage: noOp,
        renderReader: noOp
      },
      "../reader/pdf-ocr-renderer.js": {
        adjustPdfOcrZoom: noOp,
        getPdfOcrViewMode: () => "text",
        getPdfOcrZoom: () => 1,
        pdfOcrZoomStep: () => 0.1,
        resetPdfOcrZoom: noOp,
        setPdfOcrViewMode: noOp,
        setPdfOcrZoom: noOp
      }
    }, {
      window: {},
      document: { activeElement: null },
      Element: FakeElement,
      HTMLElement: FakeHtmlElement,
      HTMLButtonElement: class FakeButtonElement {},
      HTMLInputElement: class FakeInputElement {},
      HTMLSelectElement: class FakeSelectElement {
        static [Symbol.hasInstance](value) {
          return value !== null && typeof value === "object";
        }
      },
      setTimeout,
      clearTimeout,
      CSS: { escape(value) { return value; } },
      console
    }, {
      "../dom.js": { els },
      "../vocab-actions.js": {
        updateWordField(word, field, value) { articleUpdates.push([word, field, value]); }
      },
      "../reader/word-panel.js": {
        renderWordPanel() { wordPanelRenders += 1; }
      }
    });

    bindReaderEvents();
    await new Promise((resolve) => setImmediate(resolve));

    const articleButton = { dataset: { suggestArticle: "das", suggestWord: "haus" } };
    const clickTarget = new FakeElement();
    clickTarget.closest = (selector) => selector === "[data-suggest-article]" ? articleButton : null;
    els.wordPanel.dispatch("click", { target: clickTarget });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(articleUpdates, [["haus", "article", "das"]]);
    assert.equal(wordPanelRenders, 1);

    readerText.dispatch("scroll");
    const ignoredTimer = takeTimer();
    assert.equal(ignoredTimer.delay, 150);
    ignoredTimer.callback();
    assert.equal(rememberCalls.length, 0, "sub-pixel-equivalent scroll should not be persisted again");

    readerText.scrollTop = 105;
    readerText.dispatch("scroll");
    const persistenceTimer = takeTimer();
    assert.equal(persistenceTimer.delay, 150);
    persistenceTimer.callback();
    assert.equal(rememberCalls.length, 1);
    assert.equal(rememberCalls[0].precise, true);
    assert.equal(rememberCalls[0].flush, true);

    assert.equal(typeof frontendFlusher, "function");
    frontendFlusher();
    assert.equal(rememberCalls.length, 2);
    assert.equal(rememberCalls[1].precise, true);
    assert.equal(rememberCalls[1].flush, true);
  });

  it("retains graph canvases and skips obsolete animation-frame batches", async () => {
    const chartCalls = [];
    const frameQueue = [];
    const elements = new Map();
    let htmlAssignments = 0;
    let html = "";
    const graphIds = [
      "graph-vocab-progress",
      "graph-due",
      "graph-status",
      "graph-intervals",
      "graph-ease",
      "graph-reps",
      "graph-added",
      "graph-dayofweek",
      "graph-mature",
      "graph-fsrs"
    ];
    const area = { dataset: {} };
    Object.defineProperty(area, "innerHTML", {
      get() { return html; },
      set(value) {
        html = value;
        htmlAssignments++;
        for (const id of graphIds) elements.delete(id);
        for (const match of value.matchAll(/<canvas id="([^"]+)"><\/canvas>/g)) {
          elements.set(match[1], { id: match[1] });
        }
      }
    });
    elements.set("graphs-canvas-area", area);
    elements.set("graphs-heatmap", { innerHTML: "" });
    const document = { getElementById: (id) => elements.get(id) || null };
    const state = { preferences: { graphRange: "recent" }, vocab: { haus: { status: "known" } } };
    const chart = (name) => () => chartCalls.push(name);
    const noOp = () => {};
    const { renderGraphs } = await evaluateWithMocks("../../dist/web/js/views/graphs.js", {
      "../state.js": { state, saveState: noOp },
      "../i18n.js": { t: (key) => key },
      "../graphs/helpers.js": {
        updateColors: noOp,
        setGraphsLoading: noOp,
        renderHeatmap: chart("heatmap"),
        renderStatsSummary: chart("summary")
      },
      "../graphs/charts.js": {
        renderDueForecast: chart("due"),
        renderStatusDonut: chart("status"),
        renderIntervalHistogram: chart("intervals"),
        renderEaseFactors: chart("ease"),
        renderRepetitions: chart("reps"),
        renderAddedOverTime: chart("added"),
        renderDayOfWeek: chart("dayofweek"),
        renderFsrsScatter: chart("fsrs"),
        renderMatureVsYoung: chart("mature"),
        renderVocabProgress: chart("vocab-progress")
      }
    }, {
      document,
      requestAnimationFrame(callback) { frameQueue.push(callback); }
    });

    renderGraphs();
    const initialCanvases = new Map(graphIds.map((id) => [id, elements.get(id)]));
    assert.equal(htmlAssignments, 1);
    assert.equal(frameQueue.length, 1);

    renderGraphs();
    assert.equal(htmlAssignments, 1);
    for (const id of graphIds) assert.equal(elements.get(id), initialCanvases.get(id), `${id} was replaced`);
    assert.equal(frameQueue.length, 2);

    const obsoleteBatch = frameQueue.shift();
    obsoleteBatch();
    assert.deepEqual(chartCalls, []);
    assert.equal(frameQueue.length, 1, "obsolete batch should not schedule another frame");

    while (frameQueue.length) frameQueue.shift()();
    assert.equal(chartCalls.length, 12);
    assert.equal(chartCalls.at(-2), "heatmap");
    assert.equal(chartCalls.at(-1), "summary");
    assert.equal(area.dataset.graphRendered, "1");
    for (const id of graphIds) assert.equal(elements.get(id), initialCanvases.get(id), `${id} changed during drawing`);
  });

  it("scales graph canvases for the device pixel ratio", async () => {
    const transforms = [];
    const context = {
      setTransform(...args) { transforms.push(args); }
    };
    const parentElement = { clientWidth: 500 };
    const canvasElement = {
      height: 0,
      parentElement,
      width: 0,
      getContext: () => context
    };
    const { canvas } = await evaluateWithMocks("../../dist/web/js/graphs/helpers.js", {
      "../state.js": { state: { vocab: {} } },
      "../i18n.js": { t: (key) => key },
      "../loading.js": { setElementBusy() {} },
      "../views/heatmap.js": { renderContributionHeatmap() {} }
    }, {
      document: {
        documentElement: {},
        getElementById: (id) => id === "graph-test" ? canvasElement : null
      },
      window: { devicePixelRatio: 2 },
      getComputedStyle(element) {
        return element === parentElement
          ? { paddingLeft: "10px", paddingRight: "10px" }
          : { height: "300px" };
      }
    });

    assert.equal(canvas("graph-test"), context);
    assert.equal(canvasElement.width, 960);
    assert.equal(canvasElement.height, 600);
    assert.equal(context.w, 480);
    assert.equal(context.h, 300);
    assert.deepEqual(transforms, [[2, 0, 0, 2, 0, 0]]);
  });
});
