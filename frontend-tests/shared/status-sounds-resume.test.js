import { describe, it } from "node:test";
import assert from "node:assert/strict";

const resumed = [];
const gestureListeners = {};

class FakeSuspendedAudioContext {
  constructor() {
    this.currentTime = 1;
    this.destination = {};
    this.state = "suspended";
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
  createOscillator() {
    return {
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
      type: "sine"
    };
  }
  resume() {
    resumed.push(1);
    return Promise.resolve();
  }
}

globalThis.window = {
  __qtBridge: false,
  AudioContext: FakeSuspendedAudioContext,
  addEventListener(type, handler, options) {
    (gestureListeners[type] ||= []).push({ handler, options });
  },
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

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { playStatusSound } = await import("../../dist/web/js/status-sounds.js");

describe("status sounds autoplay resume", () => {
  it("resumes a suspended AudioContext on the first pointer gesture", () => {
    replaceState(createDefaultState(), { save: false });
    state.preferences.statusSoundsEnabled = true;
    state.preferences.statusSoundVolume = 1;

    playStatusSound("known");

    // The suspended branch registers one-shot gesture listeners.
    assert.equal(gestureListeners.pointerdown.length, 1);
    assert.equal(gestureListeners.keydown.length, 1);
    assert.deepEqual(gestureListeners.pointerdown[0].options, { once: true });

    const before = resumed.length;
    gestureListeners.pointerdown[0].handler();
    assert.ok(resumed.length > before, "resume() was not called by the gesture listener");
  });
});
