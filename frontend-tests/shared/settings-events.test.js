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
const { applyBridgeSnapshot } = await import("../../src/web/js/events/settings.js");

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
});
