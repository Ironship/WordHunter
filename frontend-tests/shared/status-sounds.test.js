import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const playedFrequencies = [];

class FakeAudioParam {
  setValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 1;
    this.destination = {};
    this.state = "running";
  }
  createGain() {
    return { gain: new FakeAudioParam(), connect() {} };
  }
  createOscillator() {
    return {
      frequency: {
        setValueAtTime(value) { playedFrequencies.push(value); }
      },
      connect() {},
      start() {},
      stop() {},
      type: "sine"
    };
  }
  resume() { return Promise.resolve(); }
}

globalThis.window = {
  __qtBridge: false,
  AudioContext: FakeAudioContext,
  addEventListener() {},
  dispatchEvent() {}
};
globalThis.document = {
  documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { createDefaultState, normalizeState, replaceState, state } = await import("../../dist/web/js/state.js");
const { playStatusSound } = await import("../../dist/web/js/status-sounds.js");

describe("status sounds", () => {
  beforeEach(() => {
    playedFrequencies.length = 0;
    replaceState(createDefaultState(), { save: false });
  });

  it("uses a distinct tone signature for every vocabulary status", () => {
    const signatures = [];
    for (const status of ["new", "learning", "known", "ignored"]) {
      const start = playedFrequencies.length;
      assert.equal(playStatusSound(status), true);
      signatures.push(playedFrequencies.slice(start).join(","));
    }
    assert.equal(new Set(signatures).size, 4);
  });

  it("respects mute settings", () => {
    state.preferences.statusSoundsEnabled = false;
    assert.equal(playStatusSound("known"), false);
    state.preferences.statusSoundsEnabled = true;
    state.preferences.statusSoundVolume = 0;
    assert.equal(playStatusSound("known"), false);
  });

  it("normalizes persisted sound preferences", () => {
    const normalized = normalizeState({
      ...createDefaultState(),
      preferences: {
        ...createDefaultState().preferences,
        statusSoundsEnabled: false,
        statusSoundVolume: 5
      }
    });
    assert.equal(normalized.preferences.statusSoundsEnabled, false);
    assert.equal(normalized.preferences.statusSoundVolume, 1);
  });
});
