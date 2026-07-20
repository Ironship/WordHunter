import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";

function fakeEventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((handler) => handler !== listener));
    },
    dispatchEvent(event) {
      return this.emit(event.type, event).every((result) => result !== false);
    },
    emit(type, event = {}) {
      const dispatched = { type, ...event };
      return [...(listeners.get(type) || [])].map((listener) => listener.call(this, dispatched));
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
  const module = new vm.SourceTextModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
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

function cssDeclarations(source, selectorPattern) {
  const match = source.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule ${selectorPattern}`);
  return match[1];
}

async function loadAppHarness({ hydrateCurrentReaderText = async () => true } = {}) {
  const calls = [];
  const animationFrames = [];
  const timers = [];
  let android = false;
  const classNames = new Set(["app-booting"]);
  const classList = {
    add(name) { classNames.add(name); },
    remove(name) { classNames.delete(name); },
    contains(name) { return classNames.has(name); },
    toggle(name, force) {
      if (force === true) classNames.add(name);
      else if (force === false) classNames.delete(name);
      else if (classNames.has(name)) classNames.delete(name);
      else classNames.add(name);
    }
  };
  const window = fakeEventTarget({
    __qtBridge: false,
    flushPendingSave() { calls.push("flush-save"); },
    open() {},
    requestAnimationFrame(callback) {
      assert.equal(this, window);
      animationFrames.push(callback);
      return animationFrames.length;
    }
  });
  const document = fakeEventTarget({
    visibilityState: "visible",
    documentElement: { classList, dataset: {}, style: { setProperty() {} } },
    getElementById() { return null; },
    querySelector() { return null; }
  });
  const state = { currentView: "library", preferences: {} };
  const noOp = () => {};
  const asyncNoOp = async () => {};

  await evaluateWithMocks("../../dist/web/app.js", {
    "./js/dom.js": { cacheElements: noOp, els: {} },
    "./js/toast.js": { showToast: noOp },
    "./js/events.js": { bindEvents: noOp },
    "./js/preferences.js": { applyPreferences: noOp, setSyncStatus: noOp, syncSettingsControls: noOp },
    "./js/books.js": {
      loadBooksCatalog: asyncNoOp,
      loadAllBookTexts: asyncNoOp,
      loadAllCustomTextContents: asyncNoOp,
      hydrateActiveLibraryTexts: asyncNoOp,
      hydrateCurrentReaderText
    },
    "./js/render.js": { render: () => calls.push("render"), ensureCurrentText: noOp },
    "./js/i18n.js": { loadLocale: asyncNoOp, applyTranslations: noOp, t: (key) => key },
    "./js/state.js": {
      applyBridgeSnapshotToState: noOp,
      flushFrontendStateBuffers() { calls.push("flush-buffers"); },
      flushUiStateSync: noOp,
      saveState() { calls.push("save-state"); return Promise.resolve(); },
      state
    },
    "./js/views/library.js": { bindLibraryEvents: noOp, renderLibrary: () => calls.push("render-library") },
    "./js/views/vocabulary.js": { renderReview: noOp, renderVocabulary: noOp },
    "./js/youglish.js": { refreshYouGlishTheme: noOp },
    "./js/platform.js": {
      applyPlatformUi: noOp,
      detectPlatform: noOp,
      isAndroidPlatform: () => android,
      openAndroidUrl: () => false
    }
  }, {
    window,
    document,
    Element: class Element {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    console
  }, {
    "./js/views/reader.js": { bindReaderEvents: noOp },
    "./js/update-checker.js": { checkForUpdates: noOp }
  });

  return {
    calls,
    classList,
    document,
    flushAnimationFrames() {
      for (const callback of animationFrames.splice(0)) callback();
    },
    flushTimers() {
      for (const callback of timers.splice(0)) callback();
    },
    setAndroid(value) { android = value; },
    state,
    window
  };
}

describe("persistence lifecycle", () => {
  it("dispatches lifecycle events to the platform-appropriate save path", async () => {
    const harness = await loadAppHarness();

    harness.window.emit("beforeunload");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "flush-save"]);

    harness.window.emit("pagehide");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "flush-save"]);

    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), []);
    harness.document.visibilityState = "hidden";
    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "flush-save"]);

    harness.setAndroid(true);
    harness.window.emit("pagehide");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "save-state"]);
    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "save-state"]);
  });

  it("coalesces a burst of completed book counters into one library render", async () => {
    const harness = await loadAppHarness();

    harness.window.emit("text-stats:loaded");
    harness.window.emit("text-stats:loaded");
    assert.deepEqual(harness.calls, []);
    harness.flushAnimationFrames();
    assert.deepEqual(harness.calls, ["render-library"]);
  });

  it("rerenders a restored reader after built-in book text hydration", async () => {
    const harness = await loadAppHarness();
    harness.state.currentView = "reader";
    await Promise.all(harness.document.emit("DOMContentLoaded"));
    harness.calls.length = 0;
    harness.flushTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(harness.calls, ["render"]);
  });

  it("renders and removes the boot screen without waiting for Reader hydration", async () => {
    let finishHydration;
    const hydration = new Promise((resolve) => { finishHydration = resolve; });
    const harness = await loadAppHarness({ hydrateCurrentReaderText: () => hydration });
    harness.state.currentView = "reader";
    harness.state.currentTextId = "slow-book";

    await Promise.all(harness.document.emit("DOMContentLoaded"));

    assert.equal(harness.classList.contains("app-booting"), false);
    assert.deepEqual(harness.calls, ["render"]);
    finishHydration(true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(harness.calls, ["render", "render"]);
  });

  it("backs off bridge save retries and caps the delay", async () => {
    const pendingTimers = new Map();
    const retryEvents = [];
    let nextTimerId = 1;
    let saveAttempts = 0;
    const fakeSetTimeout = (callback, delay) => {
      const id = nextTimerId++;
      pendingTimers.set(id, { callback, delay });
      return id;
    };
    const fakeClearTimeout = (id) => pendingTimers.delete(id);
    const window = {
      __qtBridge: true,
      dispatchEvent(event) { retryEvents.push(event.detail?.retryDelayMs); }
    };
    class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        saveToLocalStorage() {},
        async saveWithRetry(_body, maxRetries) {
          assert.equal(maxRetries, 3);
          saveAttempts++;
          throw new Error("filesystem unavailable");
        },
        saveSyncXhr() {}
      }
    }, {
      window,
      CustomEvent,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      console: { error() {}, warn() {} }
    });
    const rawState = { preferences: {}, profiles: {} };
    const autosave = createAutosave(() => rawState);

    await assert.rejects(autosave.saveState(), /filesystem unavailable/);
    const observedDelays = [];
    for (let index = 0; index < 7; index++) {
      const next = pendingTimers.entries().next().value;
      assert.ok(next, `missing retry timer ${index + 1}`);
      const [id, timer] = next;
      pendingTimers.delete(id);
      observedDelays.push(timer.delay);
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(observedDelays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.deepEqual(retryEvents.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.equal(saveAttempts, 8);
  });

  it("does not autosave transient backend status while preserving durable autosave", async () => {
    let scheduled = 0;
    const rawState = {
      preferences: { theme: "familiar" },
      profiles: {},
      syncHealth: null,
      syncthingStatus: null
    };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        saveToLocalStorage() {},
        async saveWithRetry() { return {}; },
        saveSyncXhr() {}
      }
    }, {
      window: { __qtBridge: false },
      setTimeout() { scheduled += 1; return scheduled; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);

    state.syncHealth = { status: "ready" };
    state.syncthingStatus = { running: true };
    assert.equal(scheduled, 0);
    assert.equal(autosave.getDurableStateRevision(), 0);
    state.preferences.theme = "classic-dark";
    assert.equal(scheduled, 1);
    assert.equal(autosave.getDurableStateRevision(), 1);
  });

  it("does not autosave bridge-only navigation and reader UI state", async () => {
    let scheduled = 0;
    const rawState = {
      currentView: "library",
      selectedWord: null,
      readerPages: {},
      filters: { vocabQuery: "" },
      preferences: { theme: "familiar" },
      profiles: {}
    };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        saveToLocalStorage() {},
        async saveWithRetry() { return {}; },
        saveSyncXhr() {}
      }
    }, {
      window: { __qtBridge: true },
      setTimeout() { scheduled += 1; return scheduled; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);

    state.currentView = "settings";
    state.selectedWord = "haus";
    state.readerPages.book = 2;
    state.filters.vocabQuery = "ha";
    assert.equal(scheduled, 0);
    assert.equal(autosave.getDurableStateRevision(), 0);

    state.preferences.theme = "alternative-familiar";
    assert.equal(scheduled, 1);
    assert.equal(autosave.getDurableStateRevision(), 1);
  });

  it("writes an explicit bridge UI save to the local UI cache", async () => {
    const saved = [];
    const backendSaves = [];
    const keepaliveUiSaves = [];
    let durableSaves = 0;
    const rawState = {
      currentView: "reader",
      currentTextId: "book",
      readerPage: 4,
      readerPages: { book: 4 },
      vocab: {}
    };
    const autosave = {
      wrap: (value) => value,
      saveState() { durableSaves += 1; return Promise.resolve(); },
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": {
        captureUiState: (value) => value,
        saveUiStateCache: (value) => saved.push(value),
        UI_STATE_KEYS: []
      },
      "./store-bridge.js": {
        postStoreJson(path, payload) { backendSaves.push([path, payload]); return Promise.resolve({}); }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      fetch(path, options) {
        keepaliveUiSaves.push([path, options]);
        return Promise.resolve({ ok: true });
      },
      console
    });

    await stateModule.saveUiState();

    assert.equal(durableSaves, 0);
    assert.deepEqual(saved, [rawState]);
    assert.equal(backendSaves[0][0], "/__store/ui_state");
    assert.equal(backendSaves[0][1].schemaVersion, 2);
    assert.equal(backendSaves[0][1].currentTextId, "book");
    stateModule.flushUiStateSync();
    assert.equal(keepaliveUiSaves[0][0], "/__store/ui_state");
    assert.equal(keepaliveUiSaves[0][1].method, "POST");
    assert.equal(keepaliveUiSaves[0][1].keepalive, true);
    assert.equal(keepaliveUiSaves[0][1].headers["X-WH-Token"], "test-token");
    assert.equal(JSON.parse(keepaliveUiSaves[0][1].body).currentTextId, "book");

    await stateModule.requestWordHunterClose();
    const closeRequest = keepaliveUiSaves.find(([path]) => path === "/__app/close");
    assert.ok(closeRequest);
    assert.equal(closeRequest[1].headers["X-WH-Token"], "test-token");
    assert.equal(durableSaves, 1);
  });

  it("drains old UI saves and defers new UI saves around an exclusive import or wipe", async () => {
    const postedPages = [];
    const keepalivePages = [];
    let releaseOldSave;
    let releaseKeepalive;
    const oldSaveBlocked = new Promise((resolve) => { releaseOldSave = resolve; });
    const keepaliveBlocked = new Promise((resolve) => { releaseKeepalive = resolve; });
    const rawState = { currentTextId: "old-book", readerPage: 7, preferences: {}, profiles: {}, vocab: {} };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.resolve(),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": {
        captureUiState: (value) => ({ currentTextId: value.currentTextId, readerPage: value.readerPage }),
        saveUiStateCache: noOp,
        UI_STATE_KEYS: []
      },
      "./store-bridge.js": {
        async postStoreJson(_path, payload) {
          postedPages.push(payload.readerPage);
          if (postedPages.length === 1) await oldSaveBlocked;
          return {};
        }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      async fetch(_path, options) {
        keepalivePages.push(JSON.parse(options.body).readerPage);
        await keepaliveBlocked;
        return { ok: true };
      },
      console
    });

    void stateModule.saveUiState();
    stateModule.flushUiStateSync();
    let exclusiveStarted = false;
    const exclusive = stateModule.runExclusiveStateWrite(async () => {
      exclusiveStarted = true;
      rawState.currentTextId = null;
      rawState.readerPage = 1;
      void stateModule.saveUiState();
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exclusiveStarted, false);

    releaseOldSave();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exclusiveStarted, false);
    releaseKeepalive();
    await exclusive;
    await stateModule.saveUiState();

    assert.deepEqual(postedPages, [7, 1, 1]);
    assert.deepEqual(keepalivePages, [7]);
  });

  it("waits for an older keepalive UI save before the final close save", async () => {
    const calls = [];
    let releaseKeepalive;
    const keepaliveBlocked = new Promise((resolve) => { releaseKeepalive = resolve; });
    const rawState = { currentTextId: "book", readerPage: 7, preferences: {}, profiles: {}, vocab: {} };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.resolve(),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": {
        captureUiState: (value) => ({ currentTextId: value.currentTextId, readerPage: value.readerPage }),
        saveUiStateCache: noOp,
        UI_STATE_KEYS: []
      },
      "./store-bridge.js": {
        async postStoreJson() { calls.push("final-ui"); return {}; }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      async fetch(path) {
        if (path === "/__store/ui_state") {
          calls.push("keepalive-start");
          await keepaliveBlocked;
          calls.push("keepalive-end");
          return { ok: true };
        }
        calls.push("close");
        return { ok: true };
      },
      console
    });

    stateModule.flushUiStateSync();
    let flushed = false;
    const flushing = stateModule.flushAllPendingFrontendState().then(() => { flushed = true; });
    const closing = stateModule.requestWordHunterClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["keepalive-start"]);
    assert.equal(flushed, false);

    releaseKeepalive();
    await Promise.all([flushing, closing]);

    assert.deepEqual(calls, ["keepalive-start", "keepalive-end", "final-ui", "close"]);
  });

  it("keeps the app open when the final durable save fails", async () => {
    const closeRequests = [];
    const toasts = [];
    const rawState = { preferences: {}, profiles: {}, vocab: {} };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.reject(new Error("disk full")),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": { captureUiState: () => ({}), saveUiStateCache: noOp, UI_STATE_KEYS: [] },
      "./store-bridge.js": { postStoreJson: async () => ({}) },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      fetch(path) { closeRequests.push(path); return Promise.resolve({ ok: true }); },
      console: { warn() {}, error() {} }
    }, {
      "./toast.js": { showToast: (message) => toasts.push(message) },
      "./i18n.js": { t: (key) => key }
    });

    await stateModule.requestWordHunterClose();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(closeRequests.includes("/__app/close"), false);
    assert.deepEqual(toasts, ["toast.syncUnavailable"]);
  });

  it("allows close after a transient UI-state save failure is retried successfully", async () => {
    const closeRequests = [];
    let uiSaveAttempts = 0;
    const rawState = { preferences: {}, profiles: {}, vocab: {} };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.resolve(),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": { captureUiState: () => ({}), saveUiStateCache: noOp, UI_STATE_KEYS: [] },
      "./store-bridge.js": {
        postStoreJson: async () => {
          uiSaveAttempts += 1;
          if (uiSaveAttempts === 1) throw new Error("temporary write failure");
          return {};
        }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      fetch(path) { closeRequests.push(path); return Promise.resolve({ ok: true }); },
      console: { warn() {}, error() {} }
    });

    await stateModule.saveUiState();
    await stateModule.requestWordHunterClose();

    assert.equal(uiSaveAttempts, 2);
    assert.deepEqual(closeRequests, ["/__app/close"]);
  });

  it("keeps the app open when the final UI-state save fails", async () => {
    const closeRequests = [];
    const toasts = [];
    const rawState = { preferences: {}, profiles: {}, vocab: {} };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.resolve(),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => rawState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": { captureUiState: () => ({}), saveUiStateCache: noOp, UI_STATE_KEYS: [] },
      "./store-bridge.js": { postStoreJson: async () => { throw new Error("ui disk full"); } },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2 }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "test-token" },
      fetch(path) { closeRequests.push(path); return Promise.resolve({ ok: true }); },
      console: { warn() {}, error() {} }
    }, {
      "./toast.js": { showToast: (message) => toasts.push(message) },
      "./i18n.js": { t: (key) => key }
    });

    await stateModule.requestWordHunterClose();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(closeRequests, []);
    assert.deepEqual(toasts, ["toast.syncUnavailable"]);
  });

  it("queues autosaves behind an exclusive state write", async () => {
    const savedThemes = [];
    let synchronousWrites = 0;
    const rawState = { preferences: { theme: "familiar" }, profiles: {} };
    class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    }
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        saveToLocalStorage() {},
        async saveWithRetry(body) {
          savedThemes.push(JSON.parse(body).preferences.theme);
          return {};
        },
        saveSyncXhr() { synchronousWrites += 1; }
      }
    }, {
      window: { __qtBridge: true, dispatchEvent() {} },
      CustomEvent,
      setTimeout: () => 1,
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);
    let queuedSave;

    await autosave.runExclusiveWrite(async () => {
      state.preferences.theme = "classic-dark";
      queuedSave = autosave.saveState();
      autosave.flushPendingSave();
      assert.deepEqual(savedThemes, ["familiar"]);
      assert.equal(synchronousWrites, 0);
    });
    await queuedSave;

    assert.deepEqual(savedThemes, ["familiar", "classic-dark"]);
  });

  it("rejects queued save waiters when the post-exclusive save fails", async () => {
    let attempts = 0;
    const rawState = { preferences: { theme: "familiar" }, profiles: {} };
    class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    }
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        saveToLocalStorage() {},
        async saveWithRetry() {
          attempts += 1;
          if (attempts > 1) throw new Error("post-import save failed");
          return {};
        },
        saveSyncXhr() {}
      }
    }, {
      window: { __qtBridge: true, dispatchEvent() {} },
      CustomEvent,
      setTimeout: () => 1,
      clearTimeout() {},
      console: { error() {}, warn() {} }
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);
    let queuedSave;

    const exclusive = autosave.runExclusiveWrite(async () => {
      state.preferences.theme = "classic-dark";
      queuedSave = autosave.saveState();
      queuedSave.catch(() => {});
    });

    await assert.rejects(exclusive, /post-import save failed/);
    await assert.rejects(queuedSave, /post-import save failed/);
  });

  it("keeps sync UI, endpoint, and event contracts", () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8");
    const autosave = readFileSync(new URL("../../dist/web/js/state/autosave.js", import.meta.url), "utf8");
    const api = readFileSync(new URL("../../dist/web/js/api.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../dist/web/js/events/settings.js", import.meta.url), "utf8");
    const storeBridge = readFileSync(new URL("../../dist/web/js/store-bridge.js", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");

    for (const id of [
      "sync-status",
      "sync-health",
      "sync-directory",
      "prepare-sync-directory",
      "choose-sync-directory",
      "sync-conflicts-panel",
      "sync-conflicts-list",
      "recovery-status-panel",
      "recovery-status-list"
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    for (const endpoint of [
      "/__store/sync_now",
      "/__store/sync_health",
      "/__store/prepare_sync_dir",
      "/__store/resolve_conflict",
      "/__store/resolve_all_conflicts"
    ]) {
      assert.ok(settings.includes(`"${endpoint}"`), `missing frontend endpoint ${endpoint}`);
    }
    assert.ok(storeBridge.includes('"/__store/ack_snapshot"'));
    for (const endpoint of [
      "/__store/recovery_status",
      "/__store/sync_health",
      "/__store/prepare_sync_dir"
    ]) {
      assert.ok(router.includes(`"${endpoint}"`), `missing router endpoint ${endpoint}`);
    }
    assert.ok(app.includes("wordhunter:sync-error"));
    assert.ok(app.includes('t("toast.syncUnavailable")'));
    assert.ok(autosave.includes("wordhunter:sync-saved"));
    assert.ok(autosave.includes("wordhunter:sync-error"));
    assert.ok(api.includes("wordhunter:sync-error"));
    assert.match(settings, /scheduleBackgroundSync\(30000\)/);
    assert.match(settings, /queueSyncOperation\(\(\) => syncNowOnce\(options\)\)/);
    assert.match(settings, /await syncNowOnce\(\{ saveFirst: false \}\)/);
    assert.match(settings, /syncNow\(\{ background: true, saveFirst: true \}\)/);
    assert.match(settings, /wordhunter:sync-snapshot-skipped/);
  });

  it("keeps startup boot CSS scoped and removes the boot state after initialization", async () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const boot = readFileSync(new URL("../../dist/web/boot.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8");

    assert.ok(html.includes('class="app-booting"'));
    assert.ok(html.includes('<meta name="theme-color" content="#00395d">'));
    const inlineBoot = cssDeclarations(html, String.raw`html\.app-booting,html\.app-booting body`);
    assert.match(inlineBoot, /overflow:\s*hidden/);
    assert.match(inlineBoot, /background:\s*var\(--boot-bg,#00395d\)/);
    assert.match(inlineBoot, /color-scheme:\s*inherit/);
    assert.match(html, /<script src="boot\.js"><\/script>/);
    assert.ok(html.indexOf('id="app-font-stylesheet"') < html.indexOf('src="boot.js"'));
    assert.ok(html.indexOf("html.app-booting") < html.indexOf('src="boot.js"'));
    assert.doesNotMatch(boot, /export \{\}/);
    assert.doesNotMatch(boot, /app-font-stylesheet/);
    assert.match(app, /getElementById\("app-font-stylesheet"\)\?\.setAttribute\("rel", "stylesheet"\)/);
    assert.ok(boot.includes('localStorage.getItem("wordHunterStateV2")'));
    assert.ok(boot.includes("root.dataset.themePref = theme"));
    assert.match(boot, /forceDesktopDark = !pocketMode && family !== "classic"/);
    assert.match(cssDeclarations(html, String.raw`html\.app-booting \.app-shell`), /visibility:\s*hidden/);

    const bootPage = cssDeclarations(styles, String.raw`html\.app-booting,\s*html\.app-booting body`);
    assert.match(bootPage, /overflow:\s*hidden/);
    assert.match(bootPage, /overscroll-behavior:\s*none/);
    assert.match(cssDeclarations(styles, String.raw`html\.app-booting \.app-shell`), /visibility:\s*hidden/);
    assert.match(cssDeclarations(styles, String.raw`html\.app-booting body::before`), /background:\s*var\(--boot-bg\)/);
    const bootLogo = cssDeclarations(styles, String.raw`html\.app-booting body::after`);
    assert.match(bootLogo, /background:\s*url\("favicon\.svg"\)/);
    assert.match(bootLogo, /animation:\s*boot-logo-pulse 1\.15s ease-in-out infinite !important/);
    assert.doesNotMatch(styles, /content: "Word Hunter"/);
    assert.ok(app.includes('fetch("/__store/load"'));

    const harness = await loadAppHarness();
    await Promise.all(harness.document.emit("DOMContentLoaded"));
    assert.equal(harness.classList.contains("app-booting"), false);
  });

  it("aborts every destructive action when backup is cancelled or fails", async () => {
    const storageRemovals = [];
    const downstreamCalls = [];
    const toasts = [];
    let applyShouldThrow = false;
    const window = fakeEventTarget({
      WH_TOKEN: "test-token",
      __qtBridge: false,
      confirm: () => true,
      WordHunterAndroid: {}
    });
    const localStorage = {
      setItem() {},
      removeItem(key) { storageRemovals.push(key); }
    };
    const state = {};
    const resetState = () => {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, {
        currentView: "settings",
        currentTextId: "text-1",
        customTexts: [{ id: "text-1", title: "Text" }],
        hiddenBuiltInBooks: ["hidden-book"],
        preferences: {
          learningLanguage: "de",
          readerBookmarks: {
            "text-1": [{ id: "text-marker" }],
            "book-1": [{ id: "book-marker" }],
            "kept-book": [{ id: "kept-marker" }]
          }
        },
        profiles: {
          de: { vocab: {}, customTexts: [], userBooks: [] },
          en: { vocab: {}, customTexts: [{ id: "kept-book" }], userBooks: [], archivedBookIds: [] }
        },
        readerPage: 2,
        readerPages: { "text-1": 2, "book-1": 1, "kept-book": 3 },
        readerScrolls: { "text-1": { scrollTop: 80 }, "book-1": { scrollTop: 10 }, "kept-book": { scrollTop: 33 } },
        readerScrollsPerPage: { "text-1-p2": 80, "book-1-p1": 10, "kept-book-p3": 33, "text-1-publisher-p1": 44 },
        reviewIndex: 1,
        selectedWord: "haus",
        userBooks: [{ id: "book-1" }],
        vocab: { haus: { status: "known" } }
      });
      state.profiles.de.vocab = state.vocab;
      state.profiles.de.customTexts = state.customTexts;
      state.profiles.de.userBooks = state.userBooks;
    };
    resetState();
    class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
    const noOp = () => {};
    const actions = await evaluateWithMocks("../../dist/web/js/sync-actions.js", {
      "./state.js": {
        applyBridgeSnapshotToState: (_snapshot, options) => {
          if (applyShouldThrow) throw new Error("invalid wiped snapshot");
          downstreamCalls.push({ applyBridgeSnapshotToState: options, storageRemovals: [...storageRemovals] });
          state.currentTextId = null;
          state.readerPages = {};
          state.readerScrolls = {};
          return true;
        },
        getDurableStateRevision: () => 0,
        state,
        saveState: async () => downstreamCalls.push("saveState"),
        saveUiState: async () => downstreamCalls.push("saveUiState"),
        runExclusiveStateWrite: async (callback) => {
          downstreamCalls.push("runExclusiveStateWrite");
          return callback();
        },
        createDefaultState: () => ({
          currentTextId: null,
          readerPages: {},
          readerScrolls: {},
          readerScrollsPerPage: {},
          preferences: { learningLanguage: "de", readerBookmarks: {} },
          profiles: { de: { vocab: {}, customTexts: [], userBooks: [] } },
          customTexts: [],
          userBooks: [],
          vocab: {}
        }),
        normalizeState: (value) => value,
        replaceState: (value) => {
          downstreamCalls.push("replaceState");
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, value);
        },
        resetInitialVocabKeys: () => downstreamCalls.push("resetInitialVocabKeys"),
        clearLastReadTextForLanguage: () => downstreamCalls.push("clearLastReadTextForLanguage")
      },
      "./constants.js": { STATE_SCHEMA_VERSION: 2, STORAGE_KEY: "wordhunter-state", UI_STORAGE_KEY: "wordhunter-ui-state" },
      "./api.js": { buildSavePayload: (value) => value },
      "./toast.js": { showToast: (message) => toasts.push(message) },
      "./i18n.js": { t: (key) => key },
      "./render.js": {
        render: () => downstreamCalls.push("render"),
        ensureCurrentText: () => downstreamCalls.push("ensureCurrentText")
      },
      "./views/vocabulary.js": {
        getOrCreateEntry: () => ({}),
        hideReviewAnswer: () => downstreamCalls.push("hideReviewAnswer")
      },
      "./text-vocab.js": { getVocabularyTextById: noOp, loadTextVocabularyIndex: async () => null },
      "./events/vocab-status.js": { VOCAB_STATUS_FILTERS: ["known", "learning"] },
      "./bridge-commit.js": {
        reloadBridgeSnapshot: async () => downstreamCalls.push("reloadBridgeSnapshot"),
        saveStateAndReloadBridge: async () => downstreamCalls.push("saveStateAndReloadBridge")
      },
      "./store-bridge.js": {
        acknowledgeBackendSnapshot: async () => downstreamCalls.push("acknowledgeBackendSnapshot"),
        deleteStoredText: async () => downstreamCalls.push("deleteStoredText"),
        loadBackendSnapshot: async () => ({}),
        postStoreCommand: async () => downstreamCalls.push("postStoreCommand"),
        postStoreJson: async () => ({})
      },
      "./state/normalize.js": { assertSupportedStateSchemaVersion: noOp },
      "./state/ui-cache.js": { captureUiState: () => ({}) },
      "./books.js": {
        clearAllBookTextCaches: () => downstreamCalls.push("clearAllBookTextCaches"),
        clearBookTextCache: () => downstreamCalls.push("clearBookTextCache"),
        loadAllBookTexts: async () => downstreamCalls.push("loadAllBookTexts"),
        loadAllCustomTextContents: async () => downstreamCalls.push("loadAllCustomTextContents"),
        loadCustomTextContent: async () => "portable backup text"
      },
      "./book-actions/profile-library.js": {
        isCustomTextReferenced: (id) => state.customTexts.some((text) => text.id === id)
          || Object.values(state.profiles || {}).some((profile) =>
            profile?.customTexts?.some((text) => text.id === id)
          )
      }
    }, {
      window,
      localStorage,
      CustomEvent,
      Blob: class Blob {},
      URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
      document: { createElement: () => ({ click() {} }) },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      setTimeout: () => 1,
      clearTimeout() {},
      console: { warn() {}, error() {} }
    });

    for (const outcome of ["cancelled", "failed"]) {
      for (const actionName of ["clearWords", "clearLibrary", "clearLocalState"]) {
        resetState();
        downstreamCalls.length = 0;
        storageRemovals.length = 0;
        toasts.length = 0;
        const before = JSON.parse(JSON.stringify(state));
        window.WordHunterAndroid.saveExport = (_data, _filename, _mime, requestId) => {
          window.dispatchEvent(new CustomEvent("wordhunter:android-export", {
            detail: outcome === "cancelled"
              ? { requestId, cancelled: true }
              : { requestId, success: false, error: "disk unavailable" }
          }));
          return true;
        };

        await actions[actionName]();

        assert.deepEqual(state, before, `${actionName} mutated state after backup ${outcome}`);
        assert.deepEqual(downstreamCalls, [], `${actionName} continued after backup ${outcome}`);
        assert.deepEqual(storageRemovals, [], `${actionName} removed storage after backup ${outcome}`);
        assert.deepEqual(toasts, ["toast.backupRequired"]);
      }
    }

    resetState();
    window.WordHunterAndroid.saveExport = (_data, _filename, _mime, requestId) => {
      window.dispatchEvent(new CustomEvent("wordhunter:android-export", {
        detail: { requestId, success: true }
      }));
      return true;
    };

    await actions.clearLibrary();

    assert.equal(state.preferences.readerBookmarks["text-1"], undefined);
    assert.equal(state.preferences.readerBookmarks["book-1"], undefined);
    assert.deepEqual(state.preferences.readerBookmarks["kept-book"], [{ id: "kept-marker" }]);
    assert.equal(state.readerPages["text-1"], undefined);
    assert.equal(state.readerPages["book-1"], undefined);
    assert.equal(state.readerPages["kept-book"], 3);
    assert.equal(state.readerScrolls["kept-book"].scrollTop, 33);
    assert.equal(state.readerScrollsPerPage["kept-book-p3"], 33);
    assert.equal(state.readerScrollsPerPage["text-1-publisher-p1"], 44);
    assert.equal(state.selectedWord, null);

    resetState();
    downstreamCalls.length = 0;
    storageRemovals.length = 0;
    window.__qtBridge = true;
    window.WordHunterAndroid = {};

    await actions.clearLocalState();

    const applyCall = downstreamCalls.find((call) => call?.applyBridgeSnapshotToState);
    assert.ok(downstreamCalls.indexOf("runExclusiveStateWrite") < downstreamCalls.indexOf("postStoreCommand"));
    assert.equal(applyCall.applyBridgeSnapshotToState.expectedRevision, undefined);
    assert.equal(applyCall.applyBridgeSnapshotToState.preserveLocalUi, false);
    assert.deepEqual(applyCall.storageRemovals, ["wordhunter-state", "wordhunter-ui-state"]);
    assert.equal(state.currentTextId, null);
    assert.deepEqual(state.readerScrolls, {});

    resetState();
    downstreamCalls.length = 0;
    storageRemovals.length = 0;
    applyShouldThrow = true;

    await actions.clearLocalState();

    assert.equal(downstreamCalls.includes("replaceState"), true);
    assert.equal(state.currentTextId, null);
    assert.deepEqual(state.readerScrolls, {});
    assert.deepEqual(storageRemovals, ["wordhunter-state", "wordhunter-ui-state"]);
  });

  it("ships sync safety copy in every locale", () => {
    const localeDir = new URL("../../dist/web/i18n/", import.meta.url);
    const required = [
      ["settings", "syncStatusDefault"],
      ["settings", "syncStatusReady"],
      ["settings", "syncStatusSaved"],
      ["settings", "syncStatusError"],
      ["settings", "cloudSyncStatusDefault"],
      ["settings", "cloudSyncStatusReady"],
      ["settings", "cloudSyncStatusSyncing"],
      ["settings", "cloudSyncStatusComplete"],
      ["settings", "cloudSyncStatusNotSupported"],
      ["settings", "cloudSyncStatusNeedsAttention"],
      ["settings", "cloudSyncStatusAuthRequired"],
      ["settings", "cloudSyncStatusOffline"],
      ["settings", "cloudSyncStatusError"],
      ["settings", "cloudSyncStatusUnknown"],
      ["settings", "syncHealthReady"],
      ["settings", "syncHealthCaution"],
      ["settings", "syncHealthNeedsAttention"],
      ["settings", "syncHealthReadOnly"],
      ["settings", "syncHealthMissing"],
      ["settings", "syncHealthNotFolder"],
      ["settings", "syncHealthUnknown"],
      ["settings", "syncConflictCount"],
      ["settings", "syncConflictDevice"],
      ["settings", "syncConflictDeleted"],
      ["settings", "syncConflictUpdated"],
      ["settings", "syncConflictRefresh"],
      ["settings", "syncConflictUnknown"],
      ["settings", "syncConflictMeta"],
      ["settings", "syncConflictKeepCurrent"],
      ["settings", "syncConflictUseOther"],
      ["settings", "syncConflictResolved"],
      ["settings", "recoveryStatusTitle"],
      ["settings", "recoveryPendingSave"],
      ["settings", "recoveryPendingSaveTemp"],
      ["settings", "recoveryPendingWipe"],
      ["settings", "recoveryQuarantinedJournal"],
      ["settings", "recoverySkippedRecords"],
      ["settings", "recoveryCorruptConflicts"],
      ["settings", "syncFolderDefault"],
      ["settings", "syncFolderPath"],
      ["settings", "prepareSyncFolder"],
      ["settings", "connectGoogleDrive"],
      ["settings", "cloudSyncNow"],
      ["settings", "chooseSyncFolder"],
      ["settings", "syncAdvanced"],
      ["settings", "syncFolderChanged"],
      ["settings", "cloudSyncConnected"],
      ["settings", "cloudSyncUnavailable"],
      ["settings", "cloudSyncComplete"],
      ["settings", "syncFolderMissing"],
      ["settings", "androidDataFolderFixed"],
      ["settings", "dataFolderCloudDelay"],
      ["settings", "forceSync"],
      ["toast", "backupCreated"],
      ["toast", "backupRequired"],
      ["toast", "exportCancelled"],
      ["toast", "syncUnavailable"]
    ];

    for (const file of readdirSync(localeDir).filter((name) => name.endsWith(".json"))) {
      const locale = JSON.parse(readFileSync(new URL(file, localeDir), "utf8"));
      for (const [section, key] of required) {
        assert.equal(typeof locale[section]?.[key], "string", `${file} missing ${section}.${key}`);
      }
    }
  });
});
