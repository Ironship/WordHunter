// The flashcard queue is memoized over copies of the vocab entries. Grading a
// word from the reader's in-text review, or editing its translation, must not
// leave the old copy in the queue: the card would be reviewed twice (inflating
// its interval) or keep showing the old content.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __qtBridge: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout, clearTimeout };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  documentElement: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} }, dataset: {}, style: {} }
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

const { renderReview, applyReviewGrade } = await import("../../dist/web/js/vocabulary/review-card.js");
const { updateWordField } = await import("../../dist/web/js/vocab-actions.js");
const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const { els } = await import("../../dist/web/js/dom.js");
const { isInReviewQueue } = await import("../../dist/web/js/sm2.js");

const shownWord = () => els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1];

describe("flashcard queue freshness", () => {
  beforeEach(() => {
    const defaults = createDefaultState();
    replaceState({ ...defaults, currentView: "flashcards", preferences: { ...defaults.preferences, learningLanguage: "de" } }, { save: false });
    els.reviewCard = { innerHTML: "", setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; } };
    els.reviewUpcoming = { innerHTML: "" };
  });

  it("drops a card graded in the reader from the queue", async () => {
    state.vocab.katze = { word: "katze", status: "learning", nextDate: "2000-01-01", repetition: 1, interval: 1, updatedAt: "2020-01-01T00:00:00Z", translation: "cat" };
    renderReview();
    assert.equal(shownWord(), "katze");

    const graded = await applyReviewGrade("katze", 4);
    assert.ok(graded.nextDate > "2000-01-01");
    renderReview();
    assert.equal(shownWord(), undefined);
  });

  it("shows a translation edited after the queue was built", () => {
    state.preferences.reviewReverse = true;
    state.vocab.hund = { word: "hund", status: "learning", nextDate: "2000-01-01", repetition: 1, interval: 1, translation: "", examples: ["Der Hund bellt."] };
    renderReview();
    assert.match(els.reviewCard.innerHTML, /review-translation-input/);

    updateWordField("hund", "translation", "dog");
    renderReview();
    assert.doesNotMatch(els.reviewCard.innerHTML, /review-translation-input/);
    assert.match(els.reviewCard.innerHTML, /dog/);
  });
});

describe("review queue membership", () => {
  it("leaves out known and ignored words, and new ones while new words stay out", () => {
    for (const autoAddLearningOnly of [false, true]) {
      assert.equal(isInReviewQueue({ status: "learning" }, autoAddLearningOnly), true);
      assert.equal(isInReviewQueue({ status: "known" }, autoAddLearningOnly), false);
      assert.equal(isInReviewQueue({ status: "ignored" }, autoAddLearningOnly), false);
    }
    assert.equal(isInReviewQueue({ status: "new" }, false), true);
    assert.equal(isInReviewQueue({ status: "new" }, true), false);
  });

  it("keeps new words out of the flashcards when only learning words are reviewed", () => {
    const defaults = createDefaultState();
    replaceState({ ...defaults, currentView: "flashcards", preferences: { ...defaults.preferences, learningLanguage: "de", autoAddLearningOnly: true } }, { save: false });
    els.reviewCard = { innerHTML: "", setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; } };
    els.reviewUpcoming = { innerHTML: "" };
    state.vocab.maus = { word: "maus", status: "new", nextDate: "2000-01-01", repetition: 0, interval: 0 };
    renderReview();
    assert.equal(shownWord(), undefined);

    state.preferences.autoAddLearningOnly = false;
    renderReview();
    assert.equal(shownWord(), "maus");
  });
});
