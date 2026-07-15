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

const { els } = await import("../../dist/web/js/dom.js");
const { createDefaultState, normalizeState, replaceState, state } = await import("../../dist/web/js/state.js");
const { syncSettingsControls } = await import("../../dist/web/js/preferences.js");
const { renderWordPanel } = await import("../../dist/web/js/reader/word-panel.js");

function control() {
  return {
    checked: false,
    hidden: false,
    style: {},
    textContent: "",
    value: "",
    setAttribute() {},
    querySelector() { return null; },
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
    "prefCardStatsMode",
    "prefCardStatsModeRow",
    "prefSelectedWordPanelItems",
    "prefStatusSoundsEnabled",
    "prefStatusSoundVolume",
    "prefStatusSoundVolumeLabel",
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

function resetState(extra = {}) {
  const defaults = createDefaultState();
  replaceState({
    ...defaults,
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

  it("synchronizes status sound mute and volume controls", () => {
    resetState();
    state.preferences.statusSoundsEnabled = false;
    state.preferences.statusSoundVolume = 0.3;

    syncSettingsControls();

    assert.equal(els.prefStatusSoundsEnabled.checked, false);
    assert.equal(els.prefStatusSoundVolume.value, "30");
    assert.equal(els.prefStatusSoundVolume.disabled, true);
    assert.equal(els.prefStatusSoundVolumeLabel.textContent, "settings.statusSoundVolume");
  });

  it("synchronizes the book counter display mode and disables it with card stats", () => {
    resetState();
    state.preferences.cardStatsMode = "both";
    state.preferences.showCardStats = false;

    syncSettingsControls();

    assert.equal(els.prefCardStatsMode.value, "both");
    assert.equal(els.prefCardStatsMode.disabled, true);
    assert.equal(els.prefCardStatsModeRow.style.opacity, "0.5");
  });

  it("defaults invalid book counter display modes to percentages", () => {
    const raw = createDefaultState();
    assert.equal(raw.preferences.cardStatsMode, "percentages");
    raw.preferences.cardStatsMode = "invalid";
    assert.equal(normalizeState(raw).preferences.cardStatsMode, "percentages");
  });

  it("uses the issue #57 selected-word panel order and clones it per default state", () => {
    const first = createDefaultState();
    const second = createDefaultState();
    assert.deepEqual(first.preferences.selectedWordPanelItems, [
      { id: "status", visible: true },
      { id: "dictionary", visible: true },
      { id: "speech", visible: true },
      { id: "youglish", visible: true },
      { id: "remove", visible: true },
      { id: "suggestion", visible: true },
      { id: "translation", visible: true },
      { id: "note", visible: true },
      { id: "image", visible: true },
      { id: "context", visible: true },
      { id: "copy", visible: false },
      { id: "edit", visible: false }
    ]);
    assert.notStrictEqual(first.preferences.selectedWordPanelItems, second.preferences.selectedWordPanelItems);
    assert.notStrictEqual(first.preferences.selectedWordPanelItems[0], second.preferences.selectedWordPanelItems[0]);
  });

  it("normalizes selected-word panel items without breaking old preferences", () => {
    const defaults = createDefaultState();
    const oldPreferences = { ...defaults.preferences };
    delete oldPreferences.selectedWordPanelItems;
    const restoredOldState = normalizeState({ ...defaults, preferences: oldPreferences });
    assert.deepEqual(restoredOldState.preferences.selectedWordPanelItems, createDefaultState().preferences.selectedWordPanelItems);

    const restored = normalizeState({
      ...createDefaultState(),
      preferences: {
        ...createDefaultState().preferences,
        selectedWordPanelItems: [
          { id: "note", visible: false },
          { id: "unknown", visible: false },
          null,
          { id: "status", visible: "false" },
          { id: "note", visible: true },
          "dictionary"
        ]
      }
    });
    assert.deepEqual(restored.preferences.selectedWordPanelItems.slice(0, 2), [
      { id: "note", visible: false },
      { id: "status", visible: true }
    ]);
    assert.equal(restored.preferences.selectedWordPanelItems.length, 12);
    assert.deepEqual(new Set(restored.preferences.selectedWordPanelItems.map((item) => item.id)).size, 12);

    const malformed = createDefaultState();
    malformed.preferences.selectedWordPanelItems = { id: "note", visible: false };
    const normalizedMalformed = normalizeState(malformed).preferences.selectedWordPanelItems;
    assert.deepEqual(normalizedMalformed, createDefaultState().preferences.selectedWordPanelItems);
    assert.notStrictEqual(normalizedMalformed, createDefaultState().preferences.selectedWordPanelItems);
  });

  it("renders ordered visibility and movement controls with disabled endpoints", () => {
    resetState();
    syncSettingsControls();
    const html = els.prefSelectedWordPanelItems.innerHTML;
    assert.ok(html.indexOf('data-word-panel-setting-item="status"') < html.indexOf('data-word-panel-setting-item="dictionary"'));
    assert.match(html, /data-word-panel-item-visible="copy"[^>]*aria-label=/);
    assert.match(html, /data-word-panel-item-move="status" data-direction="up" disabled/);
    assert.match(html, /data-word-panel-item-move="edit" data-direction="down" disabled/);
  });

  it("renders configured panel items in order without hidden editable controls", () => {
    resetState();
    els.wordPanel = control();
    state.selectedWord = "haus";
    state.selectedWordIndex = 4;
    state.readerSelectionRange = null;
    state.vocab.haus = { status: "known", article: "das", translation: "house", note: "noun", examples: [] };
    state.preferences.selectedWordPanelItems = [
      { id: "note", visible: true },
      { id: "dictionary", visible: true },
      { id: "speech", visible: true },
      { id: "translation", visible: false },
      { id: "status", visible: false },
      { id: "youglish", visible: false },
      { id: "remove", visible: false },
      { id: "suggestion", visible: false },
      { id: "image", visible: false },
      { id: "context", visible: false },
      { id: "copy", visible: false },
      { id: "edit", visible: false }
    ];

    renderWordPanel({ id: "reader-test", text: "Das Haus ist groß." });
    const html = els.wordPanel.innerHTML;
    assert.match(html, /data-headword-word="haus">das haus<\/h2>/);
    assert.match(html, /data-word-field="article"[^>]*value="das"/);
    assert.ok(html.indexOf('data-word-field="article"') < html.indexOf('data-word-panel-item="note"'));
    assert.ok(html.indexOf('data-word-panel-item="note"') < html.indexOf('data-word-panel-item="dictionary"'));
    assert.ok(html.indexOf('data-word-panel-item="dictionary"') < html.indexOf('data-word-panel-item="speech"'));
    assert.equal((html.match(/class="word-actions"/g) || []).length, 1);
    assert.doesNotMatch(html, /data-word-field="translation"/);
    assert.doesNotMatch(html, /data-word-panel-item="status"/);

    state.preferences.selectedWordPanelItems[0].visible = false;
    renderWordPanel({ id: "reader-test", text: "Das Haus ist groß." });
    assert.doesNotMatch(els.wordPanel.innerHTML, /data-word-field="note"/);
  });

  it("renders actionable sync conflict details when the backend exposes them", () => {
    resetState({
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
    resetState({
      syncDirectory: "/home/user/Documents/WordHunterSync",
      syncHealth: { status: "needs-attention", recordCount: 12, issueCount: 2 }
    });

    syncSettingsControls();

    assert.equal(els.syncHealth.hidden, false);
    assert.match(els.syncHealth.textContent, /settings\.syncHealthNeedsAttention/);

    resetState({ syncHealth: { status: "not-configured" } });
    syncSettingsControls();

    assert.equal(els.syncHealth.hidden, true);
    assert.equal(els.syncHealth.textContent, "");
  });

  it("renders cloud sync status separately from the local sync folder", () => {
    resetState({
      cloudSyncStatus: { configured: true, status: "ready", remote: "gdrive:WordHunterSync" }
    });

    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusReady/);

    resetState({ cloudSyncStatus: { status: "not_configured" } });
    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusDefault/);

    resetState({ cloudSyncStatus: { supported: false, status: "not_supported" } });
    syncSettingsControls();

    assert.match(els.cloudSyncStatus.textContent, /settings\.cloudSyncStatusNotSupported/);
  });

  it("renders recovery status details only when the backend reports issues", () => {
    resetState({
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

    resetState({ recoveryStatus: { schemaVersion: 1 } });
    syncSettingsControls();

    assert.equal(els.recoveryStatusPanel.hidden, true);
    assert.equal(els.recoveryStatusList.innerHTML, "");
  });
});
