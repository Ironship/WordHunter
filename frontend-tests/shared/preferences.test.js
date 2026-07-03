import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  location: { search: "" },
  addEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false }; }
};

globalThis.document = {
  documentElement: {
    dataset: { platform: "desktop" },
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} }
  },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
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
const { createDefaultState, replaceState, state } = await import("../../src/web/js/state.js");
const { syncSettingsControls } = await import("../../src/web/js/preferences.js");

function control() {
  return {
    checked: false,
    hidden: false,
    style: {},
    textContent: "",
    value: "",
    setAttribute() {},
    querySelectorAll() { return []; }
  };
}

function setupSettingsControls() {
  els.prefLocales = [];
  els.prefLearningLanguages = [];
  els.ankiExportStatusFilters = [];
  els.prefLearningColors = [];
  for (const key of [
    "prefFont",
    "prefLineHeight",
    "prefWordsPerPage",
    "prefWordAlgorithm",
    "prefSrsAlgorithm",
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
    "recoveryStatusList"
  ]) {
    els[key] = control();
  }
}

function resetState(migrationStatus, extra = {}) {
  const defaults = createDefaultState();
  replaceState({
    ...defaults,
    migrationStatus,
    preferences: { ...defaults.preferences, locale: "en", learningLanguage: "de" },
    vocab: { haus: { status: "known" } },
    customTexts: [{ id: "de-custom-note", title: "Note" }],
    ...extra
  }, { save: false });
}

describe("preferences settings summary", () => {
  beforeEach(() => {
    setupSettingsControls();
  });

  it("surfaces completed storage migration status only when complete", () => {
    resetState({ status: "complete", recordsActive: true });
    syncSettingsControls();

    assert.match(els.storageSummary.textContent, /settings\.migrationComplete/);

    resetState({ status: "records-active", recordsActive: true });
    syncSettingsControls();

    assert.doesNotMatch(els.storageSummary.textContent, /settings\.migrationComplete/);
    assert.equal(state.migrationStatus.status, "records-active");
  });

  it("renders actionable sync conflict details when the backend exposes them", () => {
    resetState(null, {
      syncConflictCount: 1,
      syncConflicts: [{
        id: "1234-conflict",
        key: "vocab:de:haus",
        kept: { kind: "vocab", deviceId: "pc-device", deleted: false },
        conflict: { kind: "vocab", deviceId: "phone-device", deleted: true }
      }]
    });

    syncSettingsControls();

    assert.equal(els.syncConflictsPanel.hidden, false);
    assert.match(els.syncStatus.textContent, /settings\.syncConflictCount/);
    assert.match(els.syncConflictsList.innerHTML, /data-conflict-id="1234-conflict"/);
    assert.match(els.syncConflictsList.innerHTML, /vocab:de:haus/);
    assert.match(els.syncConflictsList.innerHTML, /data-conflict-resolution="keep-current"/);
    assert.match(els.syncConflictsList.innerHTML, /data-conflict-resolution="use-conflict"/);
  });

  it("renders sync folder health without requiring users to understand staging", () => {
    resetState(null, {
      syncDirectory: "/home/user/Documents/WordHunterSync",
      syncHealth: { status: "needs-attention", recordCount: 12, issueCount: 2 }
    });

    syncSettingsControls();

    assert.equal(els.syncHealth.hidden, false);
    assert.match(els.syncHealth.textContent, /settings\.syncHealthNeedsAttention/);

    resetState(null, { syncHealth: { status: "not-configured" } });
    syncSettingsControls();

    assert.equal(els.syncHealth.hidden, true);
    assert.equal(els.syncHealth.textContent, "");
  });

  it("renders cloud sync status separately from the local sync folder", () => {
    resetState(null, {
      cloudSyncStatus: { configured: true, status: "ready", remote: "gdrive:WordHunterSync" }
    });

    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusReady/);

    resetState(null, { cloudSyncStatus: { status: "not_configured" } });
    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusDefault/);

    resetState(null, { cloudSyncStatus: { supported: false, status: "not_supported" } });
    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusNotSupported/);
  });

  it("renders recovery status details only when the backend reports issues", () => {
    resetState(null, {
      recoveryStatus: {
        schemaVersion: 1,
        skippedRecordCount: 1,
        skippedRecords: [{ path: "records/v1/vocab/bad.json", kind: "vocab", error: "corrupt" }],
        corruptConflictCount: 1,
        corruptConflicts: [{ path: "records/v1/conflicts/bad.json", error: "corrupt" }],
        quarantinedSaveJournal: true
      }
    });

    syncSettingsControls();

    assert.equal(els.recoveryStatusPanel.hidden, false);
    assert.match(els.recoveryStatusList.innerHTML, /settings\.recoveryStatusTitle/);
    assert.match(els.recoveryStatusList.innerHTML, /settings\.recoverySkippedRecords/);
    assert.match(els.recoveryStatusList.innerHTML, /settings\.recoveryCorruptConflicts/);
    assert.match(els.recoveryStatusList.innerHTML, /records\/v1\/vocab\/bad\.json/);

    resetState(null, { recoveryStatus: { schemaVersion: 1 } });
    syncSettingsControls();

    assert.equal(els.recoveryStatusPanel.hidden, true);
    assert.equal(els.recoveryStatusList.innerHTML, "");
  });
});
