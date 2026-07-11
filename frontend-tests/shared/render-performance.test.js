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
    const { rememberReaderScrollPosition } = await evaluateWithMocks("../../src/web/js/reader/scroll.js", {
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

  it("uses the imprecise path for routine reader scroll events", async () => {
    const pendingTimers = new Map();
    const rememberCalls = [];
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
    const readerText = fakeEventTarget({ dataset: { rendering: "0" }, scrollTop: 101 });
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
      readerScrolls: { "text-1": { readerPage: 2, scrollTop: 100 } }
    };
    const noOp = () => {};
    const { bindReaderEvents } = await evaluateWithMocks("../../src/web/js/views/reader.js", {
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
      "../reader/word-navigation.js": { navigateReaderWord: noOp },
      "../reader/renderer.js": { changeReaderPage: noOp, goToReaderPage: noOp, renderReader: noOp },
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
      setTimeout,
      clearTimeout,
      console
    }, {
      "../dom.js": { els }
    });

    bindReaderEvents();
    await new Promise((resolve) => setImmediate(resolve));

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
    assert.equal(rememberCalls[0].precise, false);

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
    const { renderGraphs } = await evaluateWithMocks("../../src/web/js/views/graphs.js", {
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
    const { canvas } = await evaluateWithMocks("../../src/web/js/graphs/helpers.js", {
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
