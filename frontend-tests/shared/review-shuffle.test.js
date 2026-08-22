import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {}, __qtBridge: false };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { addEventListener: () => {}, getElementById: () => null };

const { renderReview, reviewSessionKeyOrder } = await import("../../dist/web/js/vocabulary/review-card.js");
const { shuffleTodayReviewQueue } = await import("../../dist/web/js/vocabulary/review-card.js");
const { state } = await import("../../dist/web/js/state.js");
const { els } = await import("../../dist/web/js/dom.js");

/** Deterministic PRNG so the shuffled session order is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dueEntry(word) {
  return { word, status: "learning", nextDate: "2000-01-01", repetition: 1, interval: 2 };
}

/** Renders the deck and waits for the deferred upcoming-list summary render. */
async function renderAndCollect() {
  renderReview();
  await sleep(25);
  const upcoming = [...els.reviewUpcoming.innerHTML.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
  return { upcoming };
}

function cardOrder(count) {
  const order = [];
  for (let index = 0; index < count; index += 1) {
    state.reviewIndex = index;
    renderReview();
    order.push(els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1]);
  }
  return order;
}

describe("review upcoming list order", () => {
  it("orders due rows by the shuffled session instead of the alphabetical insertion order", async () => {
    const previousCard = els.reviewCard;
    const previousUpcoming = els.reviewUpcoming;
    const previousVocab = state.vocab;
    const previousIndex = state.reviewIndex;
    const previousRandom = Math.random;
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    try {
      Math.random = mulberry32(1234);
      els.reviewCard = { innerHTML: "" };
      els.reviewUpcoming = { innerHTML: "" };
      state.preferences.autoAddLearningOnly = true;
      state.vocab = Object.fromEntries(words.map((word) => [word, dueEntry(word)]));
      state.reviewIndex = 0;

      const { upcoming } = await renderAndCollect();

      assert.deepEqual(new Set(upcoming), new Set(words));
      // The due rows must follow the shuffled flashcard session order, not
      // the alphabetical order the words were inserted in.
      assert.deepEqual(upcoming, cardOrder(words.length));
      assert.notDeepEqual(upcoming, words);
    } finally {
      Math.random = previousRandom;
      els.reviewCard = previousCard;
      els.reviewUpcoming = previousUpcoming;
      state.vocab = previousVocab;
      state.reviewIndex = previousIndex;
    }
  });

  it("keeps future rows date-sorted after the shuffled due block", async () => {
    const previousCard = els.reviewCard;
    const previousUpcoming = els.reviewUpcoming;
    const previousVocab = state.vocab;
    const previousIndex = state.reviewIndex;
    const previousRandom = Math.random;
    const dueWords = ["able", "baker", "charlie"];
    const futureWords = [
      ["later", "2100-01-03"],
      ["sooner", "2100-01-01"],
      ["middle", "2100-01-02"]
    ];
    try {
      Math.random = mulberry32(777);
      els.reviewCard = { innerHTML: "" };
      els.reviewUpcoming = { innerHTML: "" };
      state.preferences.autoAddLearningOnly = true;
      state.vocab = Object.fromEntries([
        ...dueWords.map((word) => [word, dueEntry(word)]),
        ...futureWords.map(([word, nextDate]) => [word, { word, status: "learning", nextDate, repetition: 1, interval: 2 }])
      ]);
      state.reviewIndex = 0;

      const { upcoming } = await renderAndCollect();

      // Future block stays date-sorted and sits after the due block.
      assert.deepEqual(upcoming.slice(dueWords.length), ["sooner", "middle", "later"]);
      // The due block is the shuffled session order.
      assert.deepEqual(upcoming.slice(0, dueWords.length), cardOrder(dueWords.length));
    } finally {
      Math.random = previousRandom;
      els.reviewCard = previousCard;
      els.reviewUpcoming = previousUpcoming;
      state.vocab = previousVocab;
      state.reviewIndex = previousIndex;
    }
  });

  it("re-shuffles the remaining due cards when the shuffle action runs", async () => {
    const previousCard = els.reviewCard;
    const previousUpcoming = els.reviewUpcoming;
    const previousVocab = state.vocab;
    const previousIndex = state.reviewIndex;
    const previousRandom = Math.random;
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    try {
      Math.random = mulberry32(2026);
      els.reviewCard = { innerHTML: "" };
      els.reviewUpcoming = { innerHTML: "" };
      state.preferences.autoAddLearningOnly = true;
      state.vocab = Object.fromEntries(words.map((word) => [word, dueEntry(word)]));
      state.reviewIndex = 0;

      await renderAndCollect();
      const before = [...reviewSessionKeyOrder()];

      // Mid-session position is reset to the first card of the new order.
      shuffleTodayReviewQueue();
      const after = [...reviewSessionKeyOrder()];
      state.reviewIndex = 0;
      renderReview();

      assert.equal(state.reviewIndex, 0);
      assert.deepEqual(new Set(after), new Set(before));
      // With a deterministic PRNG the reshuffle actually changes the order.
      assert.notDeepEqual(after, before);
      assert.equal(
        els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1],
        after[0]
      );
    } finally {
      Math.random = previousRandom;
      els.reviewCard = previousCard;
      els.reviewUpcoming = previousUpcoming;
      state.vocab = previousVocab;
      state.reviewIndex = previousIndex;
    }
  });
});
