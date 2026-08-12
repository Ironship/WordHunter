import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Android single-word TTS session lifecycle", () => {
  it("ends the native TTS session when the single word finishes", async () => {
    const listeners = {};
    const speaks = [];
    let endTtsSessionCalls = 0;
    let stopTtsCalls = 0;

    globalThis.window = {
      WordHunterAndroid: {
        speak(text, lang, rate, id) {
          speaks.push({ text, lang, rate, id });
          return true;
        },
        isTtsReady() {
          return true;
        },
        endTtsSession() {
          endTtsSessionCalls += 1;
        },
        stopTts() {
          stopTtsCalls += 1;
        }
      },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
      removeEventListener(type) {
        delete listeners[type];
      },
      getSelection() {
        return { isCollapsed: true };
      }
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.document = {
      querySelectorAll() {
        return [];
      }
    };

    const { state } = await import("../../dist/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "normal";
    state.preferences.ttsWordHighlight = false;

    const { speakWord } = await import("../../dist/web/js/tts.js");
    await speakWord("Hallo");
    await Promise.resolve();

    assert.equal(speaks.length, 1);
    assert.equal(speaks[0].text, "Hallo");
    // Starting a word ends any previous native session up front...
    assert.equal(stopTtsCalls, 1);
    assert.equal(endTtsSessionCalls, 1);

    // ...and finishing the utterance ends it again, so the notification
    // and keep-screen-on flag are released even without an explicit stop.
    listeners["wordhunter:android-tts"]({ detail: { id: speaks[0].id, status: "done" } });
    assert.equal(endTtsSessionCalls, 2);
  });
});
