import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    emit(type, event = {}) {
      const dispatched = { type, ...event };
      return [...(listeners.get(type) || [])].map((listener) => listener.call(this, dispatched));
    }
  }, extra);
}

async function loadApp({ isAndroidPlatform, applyBridgeSnapshotToState }) {
  const noOp = () => {};
  const asyncNoOp = async () => {};
  const saveCalls = [];
  const state = {
    currentView: "library",
    preferences: { locale: "pl", learningLanguage: "en", languageOnboardingDone: false },
    customTexts: []
  };

  const elementPrototypes = {
    dialog: class HTMLDialogElement {},
    button: class HTMLButtonElement {}
  };
  const dialog = Object.assign(
    Object.create(elementPrototypes.dialog.prototype),
    fakeEventTarget(),
    {
      showModal() { state.__shown = (state.__shown || 0) + 1; },
      close() { state.__closed = (state.__closed || 0) + 1; }
    }
  );
  const doneButton = Object.assign(
    Object.create(elementPrototypes.button.prototype),
    fakeEventTarget()
  );

  const window = fakeEventTarget({
    __qtBridge: true,
    setTimeout() { return 0; },
    requestAnimationFrame(callback) { callback(); return 0; }
  });
  const document = fakeEventTarget({
    visibilityState: "visible",
    documentElement: { classList: { contains: () => false, add: noOp, remove: noOp }, dataset: {}, style: { setProperty: noOp } },
    getElementById(id) {
      if (id === "language-onboarding-dialog") return dialog;
      if (id === "language-onboarding-done") return doneButton;
      return null;
    }
  });

  const contextGlobals = {
    window,
    document,
    console,
    setTimeout() { return 0; },
    clearTimeout() {},
    Element: class Element {},
    HTMLButtonElement: elementPrototypes.button,
    HTMLDialogElement: elementPrototypes.dialog
  };
  const context = vm.createContext(contextGlobals);
  const modules = new Map();
  const createMock = (specifier, values) => new vm.SyntheticModule(
    Object.keys(values),
    function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    },
    { context, identifier: `mock:${specifier}` }
  );
  const importValues = {
    "./js/dom.js": { cacheElements: noOp, els: {} },
    "./js/toast.js": { showToast: noOp, renderToast: noOp },
    "./js/events.js": { bindEvents: noOp },
    "./js/preferences.js": { applyPreferences: asyncNoOp, syncSettingsControls: noOp },
    "./js/books.js": { hydrateCurrentReaderText: async () => true, loadBooksCatalog: asyncNoOp },
    "./js/render.js": { render: noOp, ensureCurrentText: noOp },
    "./js/i18n.js": { loadLocale: asyncNoOp, applyTranslations: noOp, t: (key) => key, getLocale: () => "en", initialLocale: () => "en" },
    "./js/state.js": {
      applyBridgeSnapshotToState,
      flushFrontendStateBuffers: noOp,
      flushUiStateSync: noOp,
      saveState() { saveCalls.push("save"); return Promise.resolve(); },
      state
    },
    "./js/api.js": {
      buildSavePayload: () => "{}",
      saveSyncXhr: noOp,
      flushPendingDeltaToLocalStorage: noOp,
      readPendingDelta: () => null,
      clearPendingDelta: noOp,
      saveWithRetry: async () => ({})
    },
    "./js/views/library.js": { bindLibraryEvents: noOp, renderDeleteBookDialog: noOp, renderLibraryPanel: noOp, renderLibrary: noOp },
    "./js/views/vocabulary.js": { renderReview: noOp, renderVocabulary: noOp },
    "./js/youglish.js": { refreshYouGlishTheme: noOp, renderYouGlishModal: noOp },
    "./js/reader/bookmarks.js": { renderBookmarksDialog: noOp },
    "./js/events/move-book.js": { renderMoveBookDialog: noOp },
    "./js/events/word-editor.js": { renderAddWordDialog: noOp, refreshAddWordDialogLocalization: noOp },
    "./js/events/settings.js": { renderArgosDownloadDialog: noOp, renderSettingsView: noOp },
    "./js/update-checker.js": { checkForUpdates: asyncNoOp, renderUpdateDialog: noOp },
    "./js/onboarding.js": { renderLanguageOnboardingDialog: noOp },
    "./js/book-actions/edit-modal.js": { renderEditBookDialog: noOp },
    "./js/events/book-import.js": { renderImportPanel: noOp },
    "./js/request.js": { fetchWithTimeout: async () => ({ ok: true, json: async () => ({}) }) },
    "./js/platform.js": {
      applyPlatformUi: noOp,
      detectPlatform: noOp,
      isAndroidPlatform,
      openAndroidUrl: () => false
    }
  };
  const dynamicImportValues = {
    "./js/views/reader.js": { bindReaderEvents: noOp }
  };
  for (const [specifier, values] of Object.entries({ ...importValues, ...dynamicImportValues })) {
    modules.set(specifier, createMock(specifier, values));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier} from app.js`);
    return dependency;
  };
  const module = new vm.SourceTextModule(readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8"), {
    context,
    identifier: new URL("../../dist/web/app.js", import.meta.url).href,
    importModuleDynamically: async (specifier) => {
      const dependency = getModule(specifier);
      if (dependency.status === "unlinked") await dependency.link(() => {});
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    }
  });
  await module.link(getModule);
  await module.evaluate();

  return {
    state,
    window,
    document,
    dialog,
    doneButton,
    saveCalls,
    shownCount() { return state.__shown || 0; },
    closedCount() { return state.__closed || 0; },
    async settle(rounds = 6) {
      for (let index = 0; index < rounds; index++) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      for (let index = 0; index < rounds; index++) await Promise.resolve();
    }
  };
}

describe("language onboarding boot gate", () => {
  it("waits for the store snapshot before deciding to show the dialog", async () => {
    let resolveSnapshot;
    const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
    let snapshotApplied = false;

    const harness = await loadApp({
      isAndroidPlatform: () => true,
      applyBridgeSnapshotToState(snapshot) {
        snapshotApplied = true;
        // The durable store says the user already completed onboarding:
        harness.state.preferences.languageOnboardingDone = true;
        return true;
      }
    });
    harness.window.__bridgeStatePromise = snapshotPromise;

    harness.document.emit("DOMContentLoaded");
    await harness.settle();

    // Regression: the gate used to run before /__store/load resolved and the
    // dialog appeared on every single launch even with the flag persisted.
    assert.equal(snapshotApplied, false);
    assert.equal(harness.shownCount(), 0);

    resolveSnapshot({});
    await harness.settle();

    assert.equal(snapshotApplied, true);
    assert.equal(harness.shownCount(), 0);
  });

  it("still shows the dialog once on a genuine first run and persists the confirmation", async () => {
    let resolveSnapshot;
    const snapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve; });
    let clickHandler = null;

    const harness = await loadApp({
      isAndroidPlatform: () => true,
      applyBridgeSnapshotToState(snapshot) {
        // Fresh install: nothing persisted, flag stays false.
        harness.state.preferences.languageOnboardingDone = false;
        return true;
      }
    });
    harness.window.__bridgeStatePromise = snapshotPromise;
    harness.doneButton.addEventListener = (type, handler) => {
      if (type === "click") clickHandler = handler;
    };

    harness.document.emit("DOMContentLoaded");
    await harness.settle();
    assert.equal(harness.shownCount(), 0);

    resolveSnapshot({});
    await harness.settle();

    assert.equal(harness.shownCount(), 1);

    clickHandler();
    assert.equal(harness.state.preferences.languageOnboardingDone, true);
    assert.deepEqual(harness.saveCalls, ["save"]);
    assert.equal(harness.closedCount(), 1);

    // The presented latch must not show it twice within one session:
    resolveSnapshot({});
    await harness.settle();
    assert.equal(harness.shownCount(), 1);
  });

  it("never shows the dialog on desktop regardless of the flag", async () => {
    const harness = await loadApp({
      isAndroidPlatform: () => false,
      applyBridgeSnapshotToState() { return true; }
    });

    harness.document.emit("DOMContentLoaded");
    await harness.settle();

    assert.equal(harness.shownCount(), 0);
    assert.equal(harness.state.preferences.languageOnboardingDone, false);
  });
});
