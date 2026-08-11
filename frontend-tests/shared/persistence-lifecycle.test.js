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

async function loadAppHarness({
  applyPreferences = () => {},
  hydrateActiveLibraryTexts = async () => {},
  hydrateCurrentReaderText = async () => true,
  loadBooksCatalog = async () => {},
  loadLocale = async () => {},
  pendingDelta = null,
  hasPending = false,
  deltaEnvelope = { payload: "{}", session: "harness", sequence: 0 }
} = {}) {
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
    hasPendingChanges() { return hasPending; },
    buildPendingDeltaEnvelope() { calls.push("build-envelope"); return deltaEnvelope; },
    open() {},
    requestAnimationFrame(callback) {
      assert.equal(this, window);
      animationFrames.push(callback);
      return animationFrames.length;
    },
    setTimeout(callback) { const id = timers.length + 1; timers.push({ id, callback }); return id; },
    clearTimeout(id) { const idx = timers.findIndex((t) => t.id === id); if (idx !== -1) timers.splice(idx, 1); }
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
    "./js/toast.js": { showToast: noOp, renderToast: noOp },
    "./js/events.js": { bindEvents: noOp },
    "./js/preferences.js": { applyPreferences, setSyncStatus: noOp, syncSettingsControls: noOp },
    "./js/books.js": {
      loadBooksCatalog,
      loadAllBookTexts: asyncNoOp,
      loadAllCustomTextContents: asyncNoOp,
      hydrateActiveLibraryTexts,
      hydrateCurrentReaderText
    },
    "./js/render.js": { render: () => calls.push("render"), ensureCurrentText: noOp },
    "./js/i18n.js": { loadLocale, applyTranslations: noOp, t: (key) => key, getLocale: () => "en", initialLocale: () => "en" },
    "./js/state.js": {
      applyBridgeSnapshotToState: noOp,
      flushFrontendStateBuffers() { calls.push("flush-buffers"); },
      flushUiStateSync: noOp,
      saveState() { calls.push("save-state"); return Promise.resolve(); },
      state
    },
    "./js/api.js": {
      buildSavePayload: () => "{}",
      saveSyncXhr() { calls.push("keepalive-save"); },
      flushPendingDeltaToLocalStorage(delta) { calls.push(`pending-flush:${delta.payload}`); },
      readPendingDelta() { return pendingDelta; },
      clearPendingDelta() { calls.push("clear-pending"); },
      saveWithRetry(body) { calls.push(`replay:${body}`); return Promise.resolve({ ok: true }); }
    },
    "./js/views/library.js": { bindLibraryEvents: noOp, renderDeleteBookDialog: noOp, renderLibrary: () => calls.push("render-library") },
    "./js/views/vocabulary.js": { renderReview: noOp, renderVocabulary: noOp },
    "./js/youglish.js": { refreshYouGlishTheme: noOp },
    "./js/reader/bookmarks.js": { renderBookmarksDialog: noOp },
    "./js/events/move-book.js": { renderMoveBookDialog: noOp },
    "./js/events/word-editor.js": { renderAddWordDialog: noOp },
    "./js/events/settings.js": { renderArgosDownloadDialog: noOp },
    "./js/book-actions/edit-modal.js": { renderEditBookDialog: noOp },
    "./js/request.js": { fetchWithTimeout: async () => ({ ok: true, json: async () => ({}) }) },
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
    HTMLButtonElement: class HTMLButtonElement {},
    HTMLDialogElement: class HTMLDialogElement {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout(callback) { const id = timers.length + 1; timers.push({ id, callback }); return id; },
    clearTimeout(id) { const idx = timers.findIndex((t) => t.id === id); if (idx !== -1) timers.splice(idx, 1); },
    console
  }, {
    "./js/views/reader.js": { bindReaderEvents: noOp },
    "./js/update-checker.js": { checkForUpdates: noOp, renderUpdateDialog: noOp },
    "./js/onboarding.js": { renderLanguageOnboardingDialog: noOp },
    "./js/youglish.js": { renderYouGlishModal: noOp, openYouGlish: noOp, closeYouGlish: noOp, refreshYouGlishTheme: noOp }
  });

  return {
    calls,
    classList,
    document,
    flushAnimationFrames() {
      for (const callback of animationFrames.splice(0)) callback();
    },
    flushTimers() {
      for (const { callback } of timers.splice(0)) callback();
    },
    setAndroid(value) { android = value; },
    state,
    window
  };
}

describe("persistence lifecycle", () => {
  it("keeps one long-running full save in flight without a client-side deadline", async () => {
    let fetchCalls = 0;
    let timeoutHelperCalls = 0;
    let resolveFetch;
    const pendingResponse = new Promise((resolve) => { resolveFetch = resolve; });
    const api = await evaluateWithMocks("../../dist/web/js/api.js", {
      "./constants.js": { STATE_SCHEMA_VERSION: 2, STORAGE_KEY: "wordhunter-state" },
      "./request.js": {
        fetchWithTimeout() {
          timeoutHelperCalls += 1;
          return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
        }
      }
    }, {
      window: { WH_TOKEN: "test-token" },
      fetch() {
        fetchCalls += 1;
        return pendingResponse;
      },
      setTimeout,
      clearTimeout,
      console
    });

    let settled = false;
    const saving = api.saveWithRetry("{}", 3).finally(() => { settled = true; });
    await Promise.resolve();

    assert.equal(fetchCalls, 1);
    assert.equal(timeoutHelperCalls, 0);
    assert.equal(settled, false);

    resolveFetch({ ok: true, json: async () => ({ ok: true }) });
    await saving;
    assert.equal(fetchCalls, 1);
  });

  it("does not queue a duplicate full save when no state changed during the in-flight save", async () => {
    let attempts = 0;
    let releaseSave;
    const blockedSave = new Promise((resolve) => { releaseSave = resolve; });
    const rawState = { preferences: { theme: "familiar" }, profiles: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (value) => value,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry() {
          attempts += 1;
          if (attempts === 1) await blockedSave;
          return {};
        },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true, dispatchEvent() {} },
      CustomEvent,
      setTimeout,
      clearTimeout,
      console
    });
    const autosave = createAutosave(() => rawState);

    const first = autosave.saveState();
    const second = autosave.saveState();
    releaseSave();
    await Promise.all([first, second]);

    assert.equal(attempts, 1);
  });

  it("starts preferences, locale, and book catalog loading in parallel", async () => {
    const started = [];
    const resolvers = [];
    const pending = (name) => () => {
      started.push(name);
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const harness = await loadAppHarness({
      applyPreferences: pending("preferences"),
      loadLocale: pending("locale"),
      loadBooksCatalog: pending("catalog")
    });

    const startup = Promise.all(harness.document.emit("DOMContentLoaded"));
    await Promise.resolve();
    assert.deepEqual(started, ["preferences", "locale", "catalog"]);
    for (const resolve of resolvers) resolve();
    await startup;
    assert.deepEqual(harness.calls, ["render"]);
  });

  it("dispatches lifecycle events to the platform-appropriate save path", async () => {
    const harness = await loadAppHarness();

    harness.window.emit("beforeunload");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "flush-save"]);

    harness.window.emit("pagehide");
    assert.deepEqual(harness.calls.splice(0), []);

    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), []);
    harness.document.visibilityState = "hidden";
    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), ["flush-buffers", "flush-save"]);

    harness.setAndroid(true);
    harness.window.emit("pagehide");
    assert.deepEqual(harness.calls.splice(0), []);
    harness.document.emit("visibilitychange");
    assert.deepEqual(harness.calls.splice(0), []);
  });

  it("persists the Android teardown flush to localStorage instead of a keepalive fetch", async () => {
    // Issue #137: keepalive fetches are capped at 64 KiB while the real save
    // payload is multi-MB, so the final mutations were silently dropped on
    // every Android activity finish. The flush must go to localStorage
    // synchronously and must not rely on a keepalive fetch.
    const harness = await loadAppHarness({
      hasPending: true,
      deltaEnvelope: { payload: '{"delta":true,"fullKeys":[]}', session: "s1", sequence: 3 }
    });
    harness.setAndroid(true);

    harness.window.emit("pagehide");

    assert.deepEqual(harness.calls, [
      "flush-buffers",
      "build-envelope",
      'pending-flush:{"delta":true,"fullKeys":[]}'
    ]);
    assert.ok(
      !harness.calls.includes("keepalive-save"),
      "the multi-MB payload must not go through a keepalive fetch"
    );
  });

  it("replays a pending Android teardown flush through the normal save path at boot", async () => {
    const harness = await loadAppHarness({
      pendingDelta: { payload: '{"delta":true,"fullKeys":[]}', session: "prev", sequence: 2 }
    });

    await Promise.all(harness.document.emit("DOMContentLoaded"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(
      harness.calls.includes('replay:{"delta":true,"fullKeys":[]}'),
      "the pending delta is replayed through the normal save path"
    );
    assert.ok(harness.calls.includes("clear-pending"), "the pending flush is cleared on success");
  });

  it("clears a pending delta only when a same-session save built after the freeze supersedes it", async () => {
    // Issue #137 class: a delta frozen at an earlier hidden event must never
    // be replayed after a newer save covered its content — its frozen
    // fullKeys would tombstone keys written in the meantime. But a save whose
    // payload was built BEFORE the freeze (in-flight at hidden time) or comes
    // from a different session does NOT contain the delta's mutations and
    // must not clear it either (that would drop them forever).
    let cleared = 0;
    let pending = null;
    let releaseSave;
    const pendingResponse = new Promise((resolve) => { releaseSave = resolve; });
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        saveWithRetry() { return pendingResponse; },
        saveSyncXhr() {},
        readPendingDelta() { return pending; },
        clearPendingDelta() { cleared += 1; }
      }
    }, {
      window: { __qtBridge: true, __bridgeState: {}, dispatchEvent() {} },
      CustomEvent: class CustomEvent {},
      setTimeout: () => 1,
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => ({ preferences: {}, profiles: {} }));
    const state = autosave.wrap({ preferences: {}, profiles: {} });

    // Case 1 — save built BEFORE the freeze does not cover the delta:
    // start a save (payload sequence 0), then mutate (sequence 1) and freeze
    // the delta (sequence 1). The completing save must NOT clear it.
    const inflight = autosave.saveState();
    state.profiles.de = { words: {} };
    const envelope = autosave.buildPendingDeltaEnvelope();
    pending = envelope;
    releaseSave({ ok: true });
    await inflight;
    assert.equal(cleared, 0, "a save built before the freeze must not clear the delta");

    // Case 2 — a same-session save built after the freeze, carrying records,
    // covers the delta (even for a mutation in an already-dirty language).
    state.profiles.de.words.w1 = { status: "learning" };
    await autosave.saveState();
    assert.equal(cleared, 1, "a same-session save built after the freeze supersedes the delta");

    // Case 3 — a delta from another session is never cleared by this
    // session's saves (only the boot replay delivers and clears it).
    pending = { payload: "{}", session: "other-session", sequence: 0 };
    await autosave.saveState();
    assert.equal(cleared, 1, "a cross-session delta must not be cleared by this session's saves");
  });

  it("coalesces a burst of completed book counters into one library render", async () => {
    const harness = await loadAppHarness();

    harness.window.emit("text-stats:loaded");
    harness.window.emit("text-stats:loaded");
    assert.deepEqual(harness.calls, []);
    harness.flushTimers();
    assert.deepEqual(harness.calls, ["render-library"]);
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

  it("does not eagerly hydrate the whole Android library", async () => {
    let hydrated = false;
    const harness = await loadAppHarness({
      hydrateActiveLibraryTexts: async () => { hydrated = true; }
    });
    harness.setAndroid(true);

    await Promise.all(harness.document.emit("DOMContentLoaded"));
    assert.equal(hydrated, false);
    harness.flushAnimationFrames();
    assert.equal(hydrated, false);
    harness.flushAnimationFrames();
    harness.flushTimers();
    await Promise.resolve();
    assert.equal(hydrated, false);
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
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry(_body, maxRetries) {
          assert.equal(maxRetries, 3);
          saveAttempts++;
          throw new Error("filesystem unavailable");
        },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
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
      recoveryStatus: null
    };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry() { return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: false },
      setTimeout() { scheduled += 1; return scheduled; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);

    state.recoveryStatus = { pendingSaveJournal: true };
    assert.equal(scheduled, 0);
    assert.equal(autosave.getDurableStateRevision(), 0);
    state.preferences.theme = "classic-dark";
    assert.equal(scheduled, 1);
    assert.equal(autosave.getDurableStateRevision(), 1);
  });

  it("returns a rejected promise when local storage saving fails", async () => {
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() { throw new DOMException("quota", "QuotaExceededError"); },
        async saveWithRetry() { return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: false },
      DOMException,
      setTimeout,
      clearTimeout,
      console
    });
    const autosave = createAutosave(() => ({ preferences: {}, profiles: {} }));
    let saving;

    assert.doesNotThrow(() => { saving = autosave.saveState(); });
    await assert.rejects(saving, /quota/);
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
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry() { return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
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

  it("reports pending local changes until the save lands, then clears them", async () => {
    let scheduled = 0;
    const rawState = { preferences: { theme: "familiar" }, profiles: {}, vocab: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry() { return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true },
      setTimeout() { scheduled += 1; return scheduled; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);
    assert.equal(autosave.hasPendingChanges(), false, "clean start has no pending changes");
    state.preferences.theme = "classic-dark";
    assert.equal(autosave.hasPendingChanges(), true, "fresh edit is pending");
    await autosave.saveState();
    assert.equal(autosave.hasPendingChanges(), false, "pending clears after a successful save");
  });

  it("buffers saves to localStorage until the backend snapshot is applied", async () => {
    const localStorageSaves = [];
    const backendSaves = [];
    const rawState = { preferences: { theme: "familiar" }, profiles: {}, vocab: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage: (payload) => { localStorageSaves.push(payload); },
        async saveWithRetry(body) { backendSaves.push(body); return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true, __bridgeState: null },
      setTimeout() { return 1; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);
    state.preferences.theme = "classic-dark";
    await autosave.saveState();
    assert.equal(localStorageSaves.length, 1, "edit buffered to localStorage before the snapshot lands");
    assert.equal(backendSaves.length, 0, "nothing sent to the backend before the snapshot lands");
  });

  it("sends to the backend once the snapshot has been applied", async () => {
    const localStorageSaves = [];
    const backendSaves = [];
    const rawState = { preferences: { theme: "familiar" }, profiles: {}, vocab: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => state,
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage: (payload) => { localStorageSaves.push(payload); },
        async saveWithRetry(body) { backendSaves.push(body); return {}; },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true, __bridgeState: {} },
      setTimeout() { return 1; },
      clearTimeout() {},
      console
    });
    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);
    state.preferences.theme = "classic-dark";
    await autosave.saveState();
    assert.equal(localStorageSaves.length, 0, "no localStorage buffering once the snapshot is applied");
    assert.equal(backendSaves.length, 1, "edit sent to the backend once the snapshot is applied");
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
        postStoreJson(path, payload, _options) { backendSaves.push([path, payload]); return Promise.resolve({}); }
      },
      "./request.js": {
        fetchWithTimeout(path, options) { keepaliveUiSaves.push([path, options]); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
    assert.deepEqual(saved.map((s) => JSON.parse(s)), [{ schemaVersion: 2, ...rawState }]);
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

  it("applies a bridge snapshot when the current state's preferences are null", async () => {
    const currentState = {
      preferences: null,
      customTexts: [],
      discover: null,
      profiles: {},
      vocab: {}
    };
    const nextState = {
      preferences: { inTextReviewCompletedGuesses: 1 },
      customTexts: [],
      profiles: {},
      vocab: {}
    };
    const autosave = {
      wrap: (value) => value,
      saveState: () => Promise.resolve(),
      getDurableStateRevision: () => 0,
      runExclusiveWrite: (callback) => callback(),
      markDurableStateReplaced() {},
      flushPendingSave() {},
      hasPendingChanges: () => false,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    let loadCount = 0;
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => currentState,
        createDefaultPreferences: () => ({ inTextReviewCompletedGuesses: 0 }),
        getDefaultDictionaryUrl: () => "",
        normalizeAnkiExportStatuses: noOp,
        normalizeVocabStatusFilters: noOp
      },
      "./state/normalize.js": {
        assertSupportedStateSchemaVersion: noOp,
        loadState: () => loadCount++ === 0 ? currentState : nextState,
        normalizeState: (value) => value
      },
      "./state/ui-cache.js": {
        captureUiState: () => ({}),
        saveUiStateCache: noOp,
        UI_STATE_KEYS: []
      },
      "./store-bridge.js": { postStoreJson: async () => ({}) },
      "./request.js": { fetchWithTimeout: async () => ({ ok: true, json: async () => ({}) }) },
      "./constants.js": {
        OTHER_PROFILE_ID: "other",
        STATE_SCHEMA_VERSION: 2,
        IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3
      }
    }, {
      window: { __qtBridge: true, __bridgeState: null, WH_TOKEN: "test-token" },
      console
    });

    assert.doesNotThrow(() => stateModule.applyBridgeSnapshotToState({ schemaVersion: 2, prefs: {} }));
    assert.equal(stateModule.state.preferences.inTextReviewCompletedGuesses, 1);
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
      "./request.js": { fetchWithTimeout: async () => ({ ok: true, json: async () => ({}) }) },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
        async postStoreJson(_path, _payload, _options) { calls.push("final-ui"); return {}; }
      },
      "./request.js": {
        async fetchWithTimeout(path) {
          if (path === "/__app/close") calls.push("close");
          return { ok: true, json: async () => ({}) };
        }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
      "./request.js": {
        fetchWithTimeout(path) { closeRequests.push(path); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
    assert.deepEqual(toasts, ["toast.saveUnavailable"]);
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
        postStoreJson: async (_path, _payload, _options) => {
          uiSaveAttempts += 1;
          if (uiSaveAttempts === 1) throw new Error("temporary write failure");
          return {};
        }
      },
      "./request.js": {
        fetchWithTimeout(path) { closeRequests.push(path); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
      hasPendingChanges: () => true,
      withoutAutoSave: (callback) => callback()
    };
    const noOp = () => {};
    const stateModule = await evaluateWithMocks("../../dist/web/js/state.js", {
      "./state/autosave.js": { createAutosave: () => autosave },
      "./state/defaults.js": {
        createDefaultState: () => rawState,
        createDefaultPreferences: () => ({}),
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
      "./store-bridge.js": { postStoreJson: async (_path, _payload, _options) => { throw new Error("ui disk full"); } },
      "./request.js": {
        fetchWithTimeout(path) { closeRequests.push(path); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      },
      "./constants.js": { OTHER_PROFILE_ID: "other", STATE_SCHEMA_VERSION: 2, IN_TEXT_REVIEW_PROMPT_COMPLETION_LIMIT: 3 }
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
    assert.deepEqual(toasts, ["toast.saveUnavailable"]);
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
        buildDeltaSavePayload: (raw) => raw,
        saveToLocalStorage() {},
        async saveWithRetry(body) {
          savedThemes.push(JSON.parse(body).preferences.theme);
          return {};
        },
        saveSyncXhr() { synchronousWrites += 1; },
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
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
        buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
        saveToLocalStorage() {},
        async saveWithRetry() {
          attempts += 1;
          if (attempts > 1) throw new Error("post-import save failed");
          return {};
        },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
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

  it("keeps startup boot CSS scoped and removes the boot state after initialization", async () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");
    const boot = readFileSync(new URL("../../dist/web/boot.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8");
    const bundledApp = readFileSync(new URL("../../dist/web/js/app.bundle.js", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const bootstrapTemplate = readFileSync(new URL("../../src-tauri/templates/bootstrap.js", import.meta.url), "utf8");

    assert.ok(html.includes('class="app-booting"'));
    assert.ok(html.includes('<meta name="theme-color" content="#00395d">'));
    assert.match(html, /<script type="module" src="js\/app\.bundle\.js\?v=[0-9a-f]{12}"><\/script>/);
    assert.ok(bundledApp.length > app.length);
    const inlineBoot = cssDeclarations(html, String.raw`html\.app-booting,html\.app-booting body`);
    assert.match(inlineBoot, /overflow:\s*hidden/);
    assert.match(inlineBoot, /background:\s*var\(--boot-bg,#00395d\)/);
    assert.match(inlineBoot, /color-scheme:\s*inherit/);
    assert.match(html, /<script src="boot\.js\?v=[0-9a-f]{12}"><\/script>/);
    assert.ok(html.indexOf('id="app-font-stylesheet"') < html.indexOf('src="boot.js'));
    assert.ok(html.indexOf("html.app-booting") < html.indexOf('src="boot.js'));
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
    assert.match(bootLogo, /background:\s*url\("favicon\.svg\?v=[0-9a-f]{12}"\)/);
    assert.match(bootLogo, /animation:\s*boot-logo-pulse 1\.15s ease-in-out infinite !important/);
    assert.doesNotMatch(styles, /content: "Word Hunter"/);
    assert.ok(app.includes('fetchWithTimeout("/__store/load"'));
    assert.match(handlers, /bootstrap_script\([\s\S]*(Some|None)/);
    assert.match(bootstrapTemplate, /storeLoadController[\s\S]*12000/);
    assert.match(boot, /wordHunterBootTimeout = window\.setTimeout/);
    assert.match(boot, /Startup timed out before the application became ready/);
    assert.match(app, /clearTimeout\(window\.wordHunterBootTimeout\)/);

    const harness = await loadAppHarness();
    await Promise.all(harness.document.emit("DOMContentLoaded"));
    assert.equal(harness.classList.contains("app-booting"), false);
  });

  it("aborts every destructive action when backup is cancelled or fails", async () => {
    const storageRemovals = [];
    const downstreamCalls = [];
    const toasts = [];
    let applyShouldThrow = false;
    let transferResponse = { ok: true, saved: false };
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
      buildDeltaSavePayload: (_raw, _langs, _texts) => ({ delta: true, fullKeys: [], records: {} }),
      "./toast.js": { showToast: (message) => toasts.push(message) },
      "./dialog-backdrop.js": { showConfirmDialog: async () => true },
      "./i18n.js": { t: (key) => key },
      "./translator-preferences.js": { effectiveLearningLanguage: () => "de" },
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
      fetch: async () => ({
        ok: transferResponse.ok,
        json: async () => ({ saved: transferResponse.saved }),
        text: async () => "disk unavailable"
      }),
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
        transferResponse = { ok: outcome === "cancelled", saved: false };

        await actions[actionName]();

        assert.deepEqual(state, before, `${actionName} mutated state after backup ${outcome}`);
        assert.deepEqual(downstreamCalls, [], `${actionName} continued after backup ${outcome}`);
        assert.deepEqual(storageRemovals, [], `${actionName} removed storage after backup ${outcome}`);
        assert.deepEqual(toasts, ["toast.backupRequired"]);
      }
    }

    resetState();
    transferResponse = { ok: true, saved: true };

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

  it("ships transfer and recovery copy in every locale", () => {
    const localeDir = new URL("../../dist/web/i18n/", import.meta.url);
    const required = [
      ["transfer", "heading"],
      ["transfer", "intro"],
      ["transfer", "mergeHint"],
      ["transfer", "exportAll"],
      ["transfer", "exportWords"],
      ["transfer", "import"],
      ["settings", "recoveryStatusTitle"],
      ["settings", "recoveryPendingSave"],
      ["settings", "recoveryPendingSaveTemp"],
      ["settings", "recoveryPendingWipe"],
      ["settings", "recoveryQuarantinedJournal"],
      ["settings", "recoverySkippedRecords"],
      ["settings", "recoveryCorruptConflicts"],
      ["settings", "androidDataFolderFixed"],
      ["toast", "backupCreated"],
      ["toast", "backupRequired"],
      ["toast", "exportCancelled"],
      ["toast", "saveUnavailable"],
      ["toast", "transferExported"],
      ["toast", "transferImported"]
    ];

    for (const file of readdirSync(localeDir).filter((name) => name.endsWith(".json"))) {
      const locale = JSON.parse(readFileSync(new URL(file, localeDir), "utf8"));
      for (const [section, key] of required) {
        assert.equal(typeof locale[section]?.[key], "string", `${file} missing ${section}.${key}`);
      }
    }
});
  it("builds incremental save payloads with only changed languages and fullKeys", async () => {
    const { buildDeltaSavePayload, buildFullKeys, buildSavePayload } = await evaluateWithMocks("../../dist/web/js/api.js", {
      "./constants.js": { STATE_SCHEMA_VERSION: 2, STORAGE_KEY: "wordhunter-state" }
    }, {
      localStorage: { getItem() { return null; }, setItem() {} }
    });
    const rawState = {
      preferences: { learningLanguage: "de" },
      hiddenBuiltInBooks: ["builtin-a"],
      customTexts: [{ id: "text-1", text: "Hallo Welt." }],
      profiles: {
        de: {
          vocab: { hallo: { status: "learning", translation: "cześć" }, welt: { status: "new" } },
          customTexts: [],
          userBooks: [{ id: "book-1", title: "Buch" }],
          hiddenBuiltInBooks: [],
          archivedBookIds: []
        },
        en: {
          vocab: { hello: { status: "known" } },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: []
        }
      }
    };

    const fullKeys = buildFullKeys(rawState);
    for (const expected of [
      "profile:de", "profile:en",
      "vocab:de:hallo", "vocab:de:welt", "vocab:en:hello",
      "book:de:book-1", "text:text-1", "pref:learningLanguage", "pref:__discover", "hidden:builtin-a"
    ]) {
      assert.ok(fullKeys.includes(expected), `missing ${expected}`);
    }
    assert.equal(fullKeys.length, 10);

    const delta = buildDeltaSavePayload(rawState, new Set(["de"]), false);
    assert.equal(delta.delta, true);
    assert.deepEqual(Object.keys(delta.records.vocab), ["de"]);
    assert.deepEqual(Object.keys(delta.records.vocab.de.vocab), ["hallo", "welt"]);
    assert.ok(Array.isArray(delta.records.texts), "texts must be an array");
    assert.equal(delta.records.texts.length, 0, "clean texts must not be sent");
    assert.deepEqual(delta.records.hiddenBooks, ["builtin-a"]);
    assert.ok(Array.isArray(delta.fullKeys));

    const deltaWithTexts = buildDeltaSavePayload(rawState, new Set(), true);
    assert.equal(Object.keys(deltaWithTexts.records.vocab).length, 0, "no dirty language");
    assert.equal(deltaWithTexts.records.texts.length, 1, "dirty texts must be sent");

    const full = buildSavePayload(rawState);
    assert.equal(full.texts.length, 1);
    assert.deepEqual(Object.keys(full.vocab), ["de", "en"]);
  });

  it("falls back to a full snapshot when the backend rejects the delta with 4xx", async () => {
    const bodies = [];
    const rawState = { preferences: { theme: "familiar" }, profiles: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => ({ ...state, full: true }),
        buildDeltaSavePayload: (raw) => ({ ...raw, delta: true }),
        saveToLocalStorage() {},
        async saveWithRetry(body) {
          bodies.push(JSON.parse(body));
          if (bodies.length === 1) {
            const error = new Error("delta payload is missing fullKeys");
            error.status = 400;
            throw error;
          }
          return {};
        },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true, dispatchEvent() {} },
      CustomEvent,
      setTimeout: () => 1,
      clearTimeout() {},
      console: { error() {} }
    });
    const autosave = createAutosave(() => rawState);
    const result = await autosave.saveState();
    assert.equal(bodies.length, 2, "delta then full snapshot fallback");
    assert.equal(bodies[0].delta, true);
    assert.equal(bodies[1].full, true);
    assert.deepEqual(result, {});
  });

  it("does not fall back to a full snapshot on network failures", async () => {
    let attempts = 0;
    const rawState = { preferences: {}, profiles: {} };
    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": {
        buildSavePayload: (state) => ({ ...state, full: true }),
        buildDeltaSavePayload: (raw) => ({ ...raw, delta: true }),
        saveToLocalStorage() {},
        async saveWithRetry() {
          attempts += 1;
          throw new TypeError("Failed to fetch");
        },
        saveSyncXhr() {},
        readPendingDelta() { return null; },
        coverageCovers: () => false,
        clearPendingDelta() {}
      }
    }, {
      window: { __qtBridge: true, dispatchEvent() {} },
      CustomEvent,
      setTimeout: () => 1,
      clearTimeout() {},
      console: { error() {} }
    });
    const autosave = createAutosave(() => rawState);
    await assert.rejects(autosave.saveState(), /Failed to fetch/);
    assert.equal(attempts, 1, "network errors must not trigger the full-snapshot fallback");
  });

  it("tracks per-text and per-language mutations through the proxy into delta payloads", async () => {
    // End-to-end regression guard: real api.js payload builders wired to the
    // real proxy-based dirty tracking. Guards against the proxy-vs-target
    // keying bug that silently emptied texts/vocab in every delta payload
    // (mutations were never attributed to a language or text id).
    const bodies = [];
    const realApi = await evaluateWithMocks("../../dist/web/js/api.js", {
      "./constants.js": { STATE_SCHEMA_VERSION: 2, STORAGE_KEY: "wordhunter-state" }
    }, {
      window: { __qtBridge: true, WH_TOKEN: "tok" },
      localStorage: { getItem() { return null; }, setItem() {} },
      setTimeout: () => 1,
      clearTimeout() {},
      console: { error() {}, warn() {} },
      fetch: async (url, options) => {
        if (String(url).includes("/__store/save")) bodies.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({}) };
      }
    });

    const rawState = {
      preferences: { learningLanguage: "de", locale: "en" },
      hiddenBuiltInBooks: [],
      profiles: {
        de: {
          vocab: { hallo: { status: "new" } },
          customTexts: [{ id: "text-1", title: "Alt", text: "Hallo Welt." }],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      },
      customTexts: [],
      userBooks: [],
      archivedBookIds: []
    };
    // normalize.ts aliases the root texts array to the active profile's array.
    rawState.customTexts = rawState.profiles.de.customTexts;

    const { createAutosave } = await evaluateWithMocks("../../dist/web/js/state/autosave.js", {
      "../api.js": realApi
    }, {
      window: {
        __qtBridge: true,
        __bridgeState: { revision: 0 },
        WH_TOKEN: "tok",
        dispatchEvent() {}
      },
      CustomEvent,
      setTimeout: () => 1,
      clearTimeout() {},
      console: { error() {}, warn() {} },
      fetch: async (url, options) => {
        if (String(url).includes("/__store/save")) bodies.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({}) };
      }
    });

    const autosave = createAutosave(() => rawState);
    const state = autosave.wrap(rawState);

    // Vocab mutation through the proxy
    state.profiles.de.vocab.hallo.status = "learning";
    // Text mutation through the proxy (same array as the root customTexts)
    const book = state.profiles.de.customTexts.find((text) => text.id === "text-1");
    book.text = "Hallo verändert.";
    book.title = "Neu";

    await autosave.saveState();

    assert.equal(bodies.length, 1, "one delta save");
    const delta = bodies[0];
    assert.equal(delta.delta, true);
    assert.deepEqual(Object.keys(delta.records.vocab), ["de"], "only the mutated language is sent");
    assert.equal(delta.records.vocab.de.vocab.hallo.status, "learning");
    assert.deepEqual(delta.records.texts.map((text) => text.id), ["text-1"], "only the mutated text is sent");
    assert.equal(delta.records.texts[0].text, "Hallo verändert.");
    assert.ok(delta.fullKeys.includes("text:text-1"), "fullKeys declares the text key");
    assert.ok(delta.fullKeys.length > 5, "fullKeys still declares the whole key set");
  });
});
