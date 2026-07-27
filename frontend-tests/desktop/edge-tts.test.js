import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Edge TTS desktop contract", () => {
  it("sends the rate preset to synthesis without changing audio playbackRate", async () => {
    const requestedUrls = [];
    const audioUrls = [];
    let playCalls = 0;
    const playbackRateWrites = [];

    globalThis.Audio = class {
      constructor(url) {
        audioUrls.push(url);
      }

      set playbackRate(value) {
        playbackRateWrites.push(value);
      }

      pause() {}
      play() { playCalls += 1; return Promise.resolve(); }
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.document = { querySelectorAll: () => [] };
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      return { ok: true, blob: async () => new Blob(["audio"], { type: "audio/mpeg" }) };
    };
    globalThis.URL.createObjectURL = (_blob) => `blob:edge-${audioUrls.length + 1}`;
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.window = {
      speechSynthesis: { cancel() {} }
    };

    const { state } = await import("../../dist/web/js/state.js");
    const { speakWord, stopSpeaking } = await import("../../dist/web/js/tts.js");
    state.preferences.learningLanguage = "en";
    state.preferences.useEdgeTts = true;

    state.preferences.ttsRate = "slow";
    speakWord("slow word");
    await new Promise((resolve) => setImmediate(resolve));
    stopSpeaking();
    state.preferences.ttsRate = "fast";
    speakWord("fast word");
    await new Promise((resolve) => setImmediate(resolve));
    stopSpeaking();

    assert.deepEqual(requestedUrls, [
      "/__tts?text=slow%20word&lang=en&rate=slow",
      "/__tts?text=fast%20word&lang=en&rate=fast"
    ]);
    assert.deepEqual(audioUrls, ["blob:edge-1", "blob:edge-2"]);
    assert.equal(playCalls, 2);
    assert.deepEqual(playbackRateWrites, []);
  });

  it("highlights reader words using Edge TTS timing metadata", async () => {
    const audioInstances = [];
    const revokedUrls = [];
    const makeToken = (text) => {
      const classes = new Set(["word-token"]);
      return {
        textContent: text,
        dataset: {},
        closest: () => null,
        classList: {
          add: (value) => classes.add(value),
          remove: (value) => classes.delete(value),
          contains: (value) => classes.has(value)
        }
      };
    };
    const tokens = [makeToken("alpha"), makeToken("beta")];
    const containerClasses = new Set();
    const container = {
      querySelectorAll: (selector) => selector === ".word-token" ? tokens : [],
      contains: () => true,
      classList: {
        add: (value) => containerClasses.add(value),
        remove: (value) => containerClasses.delete(value)
      }
    };

    globalThis.Audio = class {
      constructor(url) {
        this.url = url;
        this.currentTime = 0;
        audioInstances.push(this);
      }

      pause() {}
      play() { return Promise.resolve(); }
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "X-WH-Word-Timings" ? "0,500" : null },
      blob: async () => new Blob(["audio"])
    });
    globalThis.URL.createObjectURL = () => "blob:edge-tts";
    globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);
    globalThis.document = {
      getElementById: () => null,
      querySelectorAll: (selector) => selector === ".tts-current-word"
        ? tokens.filter((token) => token.classList.contains("tts-current-word"))
        : []
    };
    globalThis.window = {
      getSelection: () => null,
      speechSynthesis: { cancel() {} }
    };

    const { state } = await import("../../dist/web/js/state.js");
    const { speakText, stopSpeaking } = await import("../../dist/web/js/tts.js");
    state.preferences.learningLanguage = "en";
    state.preferences.useEdgeTts = true;
    state.preferences.ttsWordHighlight = true;

    speakText("alpha beta", container);
    await new Promise((resolve) => setImmediate(resolve));
    const audio = audioInstances.at(-1);
    audio.onplay();
    assert.equal(tokens[0].classList.contains("tts-current-word"), true);

    audio.currentTime = 0.6;
    audio.ontimeupdate();
    audio.ontimeupdate();
    assert.equal(tokens[0].classList.contains("tts-current-word"), false);
    assert.equal(tokens[1].classList.contains("tts-current-word"), true);

    stopSpeaking();
    assert.equal(tokens[1].classList.contains("tts-current-word"), false);
    assert.deepEqual(revokedUrls, ["blob:edge-tts"]);
  });

  it("fetches continuous Edge audio even when word highlighting is disabled", async () => {
    const requests = [];
    const audioInstances = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        headers: { get: () => null },
        blob: async () => new Blob(["audio"])
      };
    };
    globalThis.URL.createObjectURL = () => "blob:no-highlights";
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.Audio = class {
      constructor() { audioInstances.push(this); }
      pause() {}
      play() { return Promise.resolve(); }
    };
    globalThis.document = { querySelectorAll: () => [] };
    globalThis.window = { getSelection: () => null, speechSynthesis: { cancel() {} } };
    const { state } = await import("../../dist/web/js/state.js");
    const { speakText, stopSpeaking } = await import("../../dist/web/js/tts.js");
    state.preferences.learningLanguage = "en";
    state.preferences.useEdgeTts = true;
    state.preferences.ttsWordHighlight = false;
    state.preferences.ttsRate = "normal";

    speakText("bounded sentence");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(requests, ["/__tts?text=bounded%20sentence&lang=en&rate=normal"]);
    assert.equal(audioInstances.length, 1);
    stopSpeaking();
  });

  it("ignores errors from a superseded local speech session", async () => {
    const utterances = [];
    let cancelCalls = 0;
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; utterances.push(this); }
    };
    globalThis.document = { querySelectorAll: () => [] };
    globalThis.window = {
      getSelection: () => null,
      speechSynthesis: {
        cancel() { cancelCalls += 1; },
        getVoices: () => [],
        speak() {}
      }
    };
    const { state } = await import("../../dist/web/js/state.js");
    const { speakText, stopSpeaking } = await import("../../dist/web/js/tts.js");
    state.preferences.useEdgeTts = false;

    speakText("first sentence.");
    const stale = utterances.at(-1);
    speakText("second sentence.");
    const afterReplacement = cancelCalls;
    stale.onerror(new Error("canceled"));

    assert.equal(cancelCalls, afterReplacement);
    stopSpeaking();
  });
});
