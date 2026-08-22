import { describe, it } from "node:test";
import assert from "node:assert/strict";

function buildTtsHarness({ tokenWords, rects }) {
  const listeners = {};
  const calls = [];
  const intervals = [];
  const cleared = [];
  let watchdogTick = null;

  globalThis.window = {
    WordHunterAndroid: {
      speak(text, lang, rate, id) {
        calls.push({ text, lang, rate, id });
        return true;
      },
      stopTts() {}
    },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    removeEventListener(type) {
      delete listeners[type];
    },
    getSelection() {
      return { isCollapsed: true };
    },
    setInterval(fn, ms) {
      watchdogTick = fn;
      intervals.push(ms);
      return intervals.length;
    },
    clearInterval(id) {
      cleared.push(id);
      watchdogTick = null;
    },
    setTimeout(fn, ms) {
      return 0;
    },
    clearTimeout() {}
  };

  const classes = tokenWords.map(() => new Set());
  const tokens = tokenWords.map((word, index) => ({
    word,
    rect: rects[index],
    classSet: classes[index]
  }));
  const rendered = tokens.map((token) => ({
    textContent: token.word,
    dataset: {},
    classList: {
      add: (name) => token.classSet.add(name),
      remove: (name) => token.classSet.delete(name)
    },
    closest: () => container,
    getBoundingClientRect: () => token.rect
  }));

  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === ".tts-current-word") {
        return rendered.filter((_, index) => classes[index].has("tts-current-word"));
      }
      return [];
    }
  };

  let container = null;
  return {
    calls,
    intervals,
    cleared,
    rendered,
    classes,
    listeners,
    get watchdogTick() { return watchdogTick; },
    attachContainer(element) { container = element; }
  };
}

function makeContainer(scrolls) {
  return {
    classList: { add() {} },
    querySelectorAll: () => currentRendered,
    contains: () => true,
    clientHeight: 100,
    scrollHeight: 500,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    scrollTo(options) { scrolls.push(options); this.scrollTop = options.top; }
  };
}

let currentRendered = [];

describe("TTS read-along visibility", () => {
  it("keeps the highlighted word visible via the watchdog when it leaves the viewport", async () => {
    const harness = buildTtsHarness({
      tokenWords: ["Hallo", "Welt"],
      rects: [
        { top: 20, bottom: 40, height: 20 },
        { top: 30, bottom: 50, height: 20 }
      ]
    });
    const { state } = await import("../../dist/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "normal";
    state.preferences.ttsWordHighlight = true;

    const { speakText, stopSpeaking } = await import("../../dist/web/js/tts.js");

    const scrolls = [];
    currentRendered = harness.rendered;
    const container = makeContainer(scrolls);
    harness.attachContainer(container);

    await speakText("Hallo Welt.", container, null);
    assert.equal(harness.intervals.length, 1);
    assert.equal(typeof harness.watchdogTick, "function");

    const utterance = harness.calls[harness.calls.length - 1];
    assert.equal(utterance.text, "Hallo Welt.");

    // First word becomes highlighted while fully inside the viewport:
    harness.listeners["wordhunter:android-tts"]({
      detail: { id: utterance.id, status: "range", start: 0, end: 5 }
    });
    assert.equal(harness.classes[0].has("tts-current-word"), true);
    assert.deepEqual(scrolls, []);

    // The user scrolls away / layout shifts and the word ends up below the fold.
    // The watchdog must scroll it back into view without a new boundary event.
    harness.rendered[0].getBoundingClientRect = () => ({ top: 300, bottom: 320, height: 20 });
    container.scrollTop = 0;
    harness.watchdogTick();
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].top, 260);

    // A visible word must not trigger redundant scrolling on later ticks
    // (after the scroll above the word sits centered in the viewport again):
    harness.rendered[0].getBoundingClientRect = () => ({ top: 40, bottom: 60, height: 20 });
    harness.watchdogTick();
    assert.equal(scrolls.length, 1);

    stopSpeaking();
    assert.deepEqual(harness.cleared, [1]);
    assert.equal(harness.classes[0].has("tts-current-word"), false);
  });

  it("resyncs highlighting after an unmatched spoken word instead of freezing", async () => {
    const harness = buildTtsHarness({
      tokenWords: ["Eins", "Zwei", "Drei"],
      rects: [
        { top: 20, bottom: 40, height: 20 },
        { top: 40, bottom: 60, height: 20 },
        { top: 60, bottom: 80, height: 20 }
      ]
    });
    const { state } = await import("../../dist/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "normal";
    state.preferences.ttsWordHighlight = true;

    const { speakText } = await import("../../dist/web/js/tts.js");

    const scrolls = [];
    currentRendered = harness.rendered;
    const container = makeContainer(scrolls);
    harness.attachContainer(container);

    await speakText("42 Zwei Drei.", container, null);
    const utterance = harness.calls[harness.calls.length - 1];

    // "42" has no matching DOM token; tracking would freeze here before the fix.
    harness.listeners["wordhunter:android-tts"]({
      detail: { id: utterance.id, status: "range", start: 0, end: 2 }
    });
    assert.equal(harness.classes.every((set) => !set.has("tts-current-word")), false);
    assert.equal(harness.classes[0].has("tts-current-word"), false);
    assert.equal(harness.classes[1].has("tts-current-word"), true);

    const { stopSpeaking } = await import("../../dist/web/js/tts.js");
    stopSpeaking();
  });

  it("does not start the watchdog when word highlight is disabled", async () => {
    const harness = buildTtsHarness({
      tokenWords: ["Hallo"],
      rects: [{ top: 20, bottom: 40, height: 20 }]
    });
    const { state } = await import("../../dist/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "normal";
    state.preferences.ttsWordHighlight = false;

    const { speakText } = await import("../../dist/web/js/tts.js");

    const scrolls = [];
    currentRendered = harness.rendered;
    const container = makeContainer(scrolls);
    harness.attachContainer(container);

    await speakText("Hallo.", container, null);
    assert.deepEqual(harness.intervals, []);
    assert.equal(harness.calls.length, 1);

    const { stopSpeaking } = await import("../../dist/web/js/tts.js");
    stopSpeaking();
  });
});
