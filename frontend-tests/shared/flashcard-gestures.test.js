import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class FakeElement {
  constructor(interactive = false) { this.interactive = interactive; }
  closest(selector) {
    if (selector === "[data-review-card-surface]") return this;
    return this.interactive ? this : null;
  }
}
class FakeHTMLElement extends FakeElement {}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;

const { bindFlashcardEvents, flashcardGestureAction } = await import("../../dist/web/js/events/flashcards.js");
const { els } = await import("../../dist/web/js/dom.js");

class FakeHost extends FakeHTMLElement {
  constructor() {
    super();
    this.dataset = {};
    this.listeners = new Map();
    this.answerVisible = false;
    this.clicks = { next: 0, prev: 0, toggle: 0 };
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  querySelector(selector) {
    if (selector === ".flashcard-wrap") return { dataset: { answerVisible: String(this.answerVisible) } };
    const action = selector.includes("next") ? "next" : selector.includes("prev") ? "prev" : "toggle";
    return { disabled: false, click: () => { this.clicks[action] += 1; } };
  }
  emit(type, event) { this.listeners.get(type)?.(event); }
}

describe("flashcard gestures", () => {
  it("maps horizontal deck gestures without accepting vertical scrolling", () => {
    assert.equal(flashcardGestureAction(-100, 8), "next");
    assert.equal(flashcardGestureAction(100, -8), "prev");
    assert.equal(flashcardGestureAction(79, 0), null);
    assert.equal(flashcardGestureAction(120, 81), null);
    assert.equal(flashcardGestureAction(100, 70), null);
  });

  it("routes gestures through navigation buttons instead of SRS grading", () => {
    const events = readFileSync(new URL("../../dist/web/js/events/flashcards.js", import.meta.url), "utf8");
    const review = readFileSync(new URL("../../dist/web/js/vocabulary/review-card.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    assert.match(events, /#btn-flashcard-next/);
    assert.match(events, /#btn-flashcard-prev/);
    assert.match(events, /data-review-action="toggle"/);
    assert.doesNotMatch(events, /data-sm2-grade|gradeReview|applyReview/);
    assert.match(review, /reviewIndex === reviewWords\.length - 1 \? "disabled"/);
    assert.ok(html.indexOf('id="review-card"') < html.indexOf('id="review-chart-fullwidth"'));
    assert.ok(html.indexOf('id="review-chart-fullwidth"') < html.indexOf('id="review-upcoming"'));
  });

  it("reveals on a tap and navigates the deck on horizontal pointer gestures", () => {
    const host = new FakeHost();
    const surface = new FakeElement();
    els.reviewCard = host;
    bindFlashcardEvents();
    const start = (x, y, target = surface) => host.emit("pointerdown", {
      isPrimary: true, pointerType: "touch", button: 0, pointerId: 1, clientX: x, clientY: y, target
    });
    const finish = (x, y) => host.emit("pointerup", {
      pointerId: 1, clientX: x, clientY: y, preventDefault() {}
    });

    start(160, 20); finish(50, 25);
    start(50, 20); finish(160, 25);
    start(50, 20); finish(54, 24);
    start(50, 20); finish(54, 90);
    start(50, 20, new FakeElement(true)); finish(54, 24);

    assert.deepEqual(host.clicks, { next: 1, prev: 1, toggle: 1 });
  });
});
