import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Edge TTS rate contract", () => {
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
});
