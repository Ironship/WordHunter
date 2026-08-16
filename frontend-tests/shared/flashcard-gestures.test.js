import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class FakeElement {
  constructor(...selectors) {
    // Selectors this element matches (empty = plain card surface).
    this.selectors = new Set(selectors);
  }
  closest(selector) {
    const parts = String(selector).split(",").map((part) => part.trim());
    return parts.some((part) => this.selectors.has(part)) ? this : null;
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
    return {
      disabled: false,
      click: () => {
        const event = {
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; }
        };
        this.emit("click", event);
        if (!event.defaultPrevented && !event.propagationStopped) this.clicks[action] += 1;
      }
    };
  }
  emit(type, event) { this.listeners.get(type)?.(event); }
}

describe("flashcard gestures", () => {
  it("maps horizontal deck gestures without accepting vertical scrolling", () => {
    assert.equal(flashcardGestureAction(-100, 8), "next");
    assert.equal(flashcardGestureAction(100, -8), "prev");
    assert.equal(flashcardGestureAction(55, 0), null);
    assert.equal(flashcardGestureAction(56, 0), "prev");
    assert.equal(flashcardGestureAction(-60, 49), "next");
    assert.equal(flashcardGestureAction(60, 51), null);
  });

  it("routes gestures through navigation buttons instead of SRS grading", () => {
    const events = readFileSync(new URL("../../dist/web/js/events/flashcards.js", import.meta.url), "utf8");
    const review = readFileSync(new URL("../../dist/web/js/vocabulary/review-card.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    assert.match(events, /#btn-flashcard-next/);
    assert.match(events, /#btn-flashcard-prev/);
    assert.match(events, /data-review-action="toggle"/);
    assert.match(events, /\{ capture: true \}/);
    assert.doesNotMatch(events, /data-sm2-grade|gradeReview|applyReview/);
    assert.match(review, /reviewIndex === reviewWords\.length - 1 \? "disabled"/);
    assert.ok(html.indexOf('id="review-card"') < html.indexOf('id="review-chart-fullwidth"'));
    assert.ok(html.indexOf('id="review-chart-fullwidth"') < html.indexOf('id="review-upcoming"'));
  });

  it("keeps clicks on interactive controls alive inside the post-swipe suppression window", () => {
    const host = new FakeHost();
    const surface = new FakeElement("[data-review-card-surface]");
    els.reviewCard = host;
    bindFlashcardEvents();
    // Arm the 400 ms suppression window with a real swipe.
    host.emit("pointerdown", {
      isPrimary: true, pointerType: "touch", button: 0, pointerId: 2,
      clientX: 160, clientY: 20, target: surface
    });
    host.emit("pointerup", { pointerId: 2, clientX: 50, clientY: 25, preventDefault() {} });

    const clickEvent = (selector = null) => ({
      target: selector ? new FakeElement(selector) : new FakeElement(),
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }
    });

    // A tap on an image-suggestion tile / any control must survive so the
    // document-level handler (setWordImage) can still run.
    const tileEvent = clickEvent("button");
    host.emit("click", tileEvent);
    assert.equal(tileEvent.defaultPrevented, false);
    assert.equal(tileEvent.propagationStopped, false);

    // The upload tile is a div[role="button"], not a <button> — it must
    // survive as well.
    const uploadEvent = clickEvent('[role="button"]');
    host.emit("click", uploadEvent);
    assert.equal(uploadEvent.defaultPrevented, false);
    assert.equal(uploadEvent.propagationStopped, false);

    // The stray synthetic click a swipe leaves on the plain card surface
    // must still be swallowed.
    const surfaceEvent = clickEvent();
    host.emit("click", surfaceEvent);
    assert.equal(surfaceEvent.defaultPrevented, true);
    assert.equal(surfaceEvent.propagationStopped, true);
  });

  it("keeps word-panel control taps alive after a reader word-card swipe", () => {
    // The reader word panel has the same post-swipe click suppression; both
    // the capture and bubble handlers must exempt interactive controls or
    // the reader 'add image' path stays dead on Android.
    const reader = readFileSync(new URL("../../dist/web/js/views/reader.js", import.meta.url), "utf8");
    assert.match(reader, /\[role=/);
    assert.equal((reader.match(/closest\(INTERACTIVE_CLICK_SELECTOR\)/g) || []).length, 2);
  });

  it("reveals on a tap and navigates the deck on horizontal pointer gestures", () => {
    const host = new FakeHost();
    const surface = new FakeElement("[data-review-card-surface]");
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
    start(50, 20, new FakeElement("button")); finish(54, 24);

    assert.deepEqual(host.clicks, { next: 1, prev: 1, toggle: 1 });
  });
});
