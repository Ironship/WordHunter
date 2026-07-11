import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: true,
  __bridgeState: null,
  WH_TOKEN: "",
  WordHunterAndroid: null,
  location: { search: "" },
  addEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false }; },
  setTimeout,
  clearTimeout,
  setInterval() { return 0; }
};

globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "failed" }) });

globalThis.document = {
  documentElement: {
    dataset: { platform: "desktop" },
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} }
  },
  visibilityState: "visible",
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() {
    return {
      appendChild() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      style: {},
      classList: { add() {}, remove() {}, toggle() {} }
    };
  }
};

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { els } = await import("../../src/web/js/dom.js");
const { STATE_SCHEMA_VERSION, createDefaultState, replaceState, state } = await import("../../src/web/js/state.js");
const {
  bookTexts,
  clearBookTextCache,
  isBookTextCacheStale,
  loadCustomTextContent
} = await import("../../src/web/js/books.js");
const { applyBridgeSnapshot } = await import("../../src/web/js/events/settings.js");
const { syncSettingsControls } = await import("../../src/web/js/preferences.js");

function control(extra = {}) {
  return {
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    disabled: false,
    hidden: false,
    id: "",
    innerHTML: "",
    style: {},
    textContent: "",
    value: "",
    setAttribute() {},
    querySelectorAll() { return []; },
    ...extra
  };
}

function setupDom() {
  els.navItems = [];
  els.views = [control({ id: "settings-view", dataset: { titleKey: "settings.title" } })];
  els.pageTitle = control();
  els.overallCount = control();
  els.pillKnown = control();
  els.pillLearning = control();
  els.pillNew = control();
  els.prefLocales = [];
  els.prefLearningLanguages = [];
  els.ankiExportStatusFilters = [];
  els.prefLearningColors = [];
  for (const key of [
    "prefFont",
    "prefLineHeight",
    "prefFontSize",
    "prefHighlight",
    "prefAutoLearn",
    "prefCardStats",
    "storageSummary",
    "syncStatus",
    "syncHealth",
    "cloudSyncStatus",
    "syncDirectory",
    "syncConflictsPanel",
    "syncConflictsList",
    "recoveryStatusPanel",
    "recoveryStatusList",
    "ocrGpuStatus"
  ]) {
    els[key] = control();
  }
}

function resetState(extra = {}) {
  const defaults = createDefaultState();
  replaceState({
    ...defaults,
    preferences: { ...defaults.preferences, locale: "en", learningLanguage: "de" },
    ...extra
  }, { save: false });
}

describe("settings bridge snapshots", () => {
  beforeEach(() => {
    window.__bridgeState = null;
    bookTexts.clear();
    setupDom();
  });

  it("preserves cloud connector status when local sync snapshots omit it", () => {
    const cloudSyncStatus = {
      configured: true,
      status: "ready",
      remote: "wordhunter-drive:WordHunterSync"
    };
    resetState({
      currentView: "settings",
      syncDirectory: "/home/user/Documents/WordHunterSync",
      cloudSyncStatus
    });

    applyBridgeSnapshot({
      schemaVersion: STATE_SCHEMA_VERSION,
      prefs: {},
      texts: [],
      hiddenBooks: [],
      vocab: {},
      syncDir: "/home/user/Documents/WordHunterSync",
      syncHealth: { status: "ready", recordCount: 4, issueCount: 0 }
    }, "settings");

    assert.deepEqual(state.cloudSyncStatus, cloudSyncStatus);
    assert.deepEqual(window.__bridgeState.cloudSyncStatus, cloudSyncStatus);
    assert.equal(state.syncHealth.status, "ready");
  });

  it("does not serialize storage usage while Settings is hidden", () => {
    resetState({ currentView: "library" });
    let summaryWrites = 0;
    Object.defineProperty(els.storageSummary, "textContent", {
      configurable: true,
      get() { return ""; },
      set() { summaryWrites += 1; }
    });

    syncSettingsControls();
    assert.equal(summaryWrites, 0);
    state.currentView = "settings";
    syncSettingsControls();
    assert.equal(summaryWrites, 1);
  });

  it("uses explicit cloud connector status from the backend when present", () => {
    resetState({
      cloudSyncStatus: {
        configured: true,
        status: "ready",
        remote: "wordhunter-drive:WordHunterSync"
      }
    });

    applyBridgeSnapshot({
      schemaVersion: STATE_SCHEMA_VERSION,
      prefs: {},
      texts: [],
      hiddenBooks: [],
      vocab: {},
      cloudSyncStatus: { configured: false, status: "auth_required" }
    }, "settings");

    assert.deepEqual(state.cloudSyncStatus, { configured: false, status: "auth_required" });
  });

  it("applies canonical bridge data without overwriting local reader UI state", () => {
    resetState({
      currentView: "reader",
      currentTextId: "de-custom-local",
      selectedWord: "haus",
      readerPage: 4,
      readerPages: { "de-custom-local": 4 },
      readerScrolls: { "de-custom-local": { scrollTop: 120, readerPage: 4 } },
      filters: { ...createDefaultState().filters, libraryQuery: "local" },
      discover: { query: "kept", source: "wikisource", sort: "newest", level: "B1", page: 3 }
    });

    applyBridgeSnapshot({
      schemaVersion: STATE_SCHEMA_VERSION,
      prefs: { learningLanguage: "de" },
      texts: [],
      hiddenBooks: [],
      vocab: {
        de: {
          preferences: {},
          vocab: { neu: { status: "known", translation: "new" } }
        }
      }
    }, "reader");

    assert.equal(state.vocab.neu.translation, "new");
    assert.equal(state.currentView, "reader");
    assert.equal(state.currentTextId, "de-custom-local");
    assert.equal(state.selectedWord, "haus");
    assert.equal(state.readerPage, 4);
    assert.deepEqual(state.readerScrolls["de-custom-local"], { scrollTop: 120, readerPage: 4 });
    assert.equal(state.filters.libraryQuery, "local");
    assert.equal(state.discover.query, "kept");
  });

  it("keeps cached book bodies visible while refreshing a sync snapshot", async () => {
    resetState({
      customTexts: [{ id: "de-custom-sync", title: "Old metadata" }]
    });
    bookTexts.set("de-custom-sync", "stale body");
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "fresh synchronized body" }) });

      applyBridgeSnapshot({
        schemaVersion: STATE_SCHEMA_VERSION,
        prefs: { learningLanguage: "de" },
        texts: [{ id: "de-custom-sync", title: "Synced metadata" }],
        hiddenBooks: [],
        vocab: { de: { preferences: {}, vocab: {} } }
      }, "library");

      assert.equal(bookTexts.get("de-custom-sync"), "stale body");
      assert.equal(isBookTextCacheStale("de-custom-sync"), true);
      assert.equal(state.customTexts[0].title, "Synced metadata");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(bookTexts.get("de-custom-sync"), "fresh synchronized body");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("clears cached bodies for books removed by a sync snapshot", () => {
    resetState({ customTexts: [{ id: "de-custom-removed", title: "Removed" }] });
    bookTexts.set("de-custom-removed", "removed body");

    applyBridgeSnapshot({
      schemaVersion: STATE_SCHEMA_VERSION,
      prefs: { learningLanguage: "de" },
      texts: [],
      hiddenBooks: [],
      vocab: { de: { preferences: {}, vocab: {} } }
    }, "library");

    assert.equal(bookTexts.has("de-custom-removed"), false);
  });

  it("keeps an active reader body until its synchronized replacement is loaded", async () => {
    resetState({
      currentView: "reader",
      currentTextId: "de-custom-sync",
      customTexts: [{ id: "de-custom-sync", title: "Old metadata" }]
    });
    bookTexts.set("de-custom-sync", "old active body");
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: "fresh synchronized body" }) });

      applyBridgeSnapshot({
        schemaVersion: STATE_SCHEMA_VERSION,
        prefs: { learningLanguage: "de" },
        texts: [{ id: "de-custom-sync", title: "Synced metadata" }],
        hiddenBooks: [],
        vocab: { de: { preferences: {}, vocab: {} } }
      }, "reader");

      assert.equal(bookTexts.get("de-custom-sync"), "old active body");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(bookTexts.get("de-custom-sync"), "fresh synchronized body");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not let an invalidated request repopulate the text cache", async () => {
    let releaseResponse;
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => new Promise((resolve) => { releaseResponse = resolve; });
      const pending = loadCustomTextContent({ id: "de-custom-delayed" });
      clearBookTextCache("de-custom-delayed");
      releaseResponse({ ok: true, json: async () => ({ text: "stale delayed body" }) });
      await pending;
      assert.equal(bookTexts.has("de-custom-delayed"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("marks a failed active refresh stale so the next open retries it", async () => {
    resetState({
      currentView: "reader",
      currentTextId: "de-custom-failed-refresh",
      customTexts: [{ id: "de-custom-failed-refresh", title: "Old metadata" }]
    });
    bookTexts.set("de-custom-failed-refresh", "last readable body");
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => { throw new Error("offline"); };
      applyBridgeSnapshot({
        schemaVersion: STATE_SCHEMA_VERSION,
        prefs: { learningLanguage: "de" },
        texts: [{ id: "de-custom-failed-refresh", title: "Synced metadata" }],
        hiddenBooks: [],
        vocab: { de: { preferences: {}, vocab: {} } }
      }, "reader");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(bookTexts.get("de-custom-failed-refresh"), "last readable body");
      assert.equal(isBookTextCacheStale("de-custom-failed-refresh"), true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
