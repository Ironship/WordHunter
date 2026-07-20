import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Edge TTS desktop contract", () => {
  it("sends the rate preset to synthesis without changing audio playbackRate", async () => {
    const audioUrls = [];
    const playbackRateWrites = [];

    globalThis.Audio = class {
      constructor(url) {
        audioUrls.push(url);
      }

      set playbackRate(value) {
        playbackRateWrites.push(value);
      }

      pause() {}
      play() { return Promise.resolve(); }
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.document = { querySelectorAll: () => [] };
    globalThis.window = {
      speechSynthesis: { cancel() {} }
    };

    const { state } = await import("../../dist/web/js/state.js");
    const { speakWord, stopSpeaking } = await import("../../dist/web/js/tts.js");
    state.preferences.learningLanguage = "en";
    state.preferences.useEdgeTts = true;

    state.preferences.ttsRate = "slow";
    speakWord("slow word");
    state.preferences.ttsRate = "fast";
    speakWord("fast word");
    stopSpeaking();

    assert.deepEqual(audioUrls, [
      "/__tts?text=slow%20word&lang=en&rate=slow",
      "/__tts?text=fast%20word&lang=en&rate=fast"
    ]);
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
});
