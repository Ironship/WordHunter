// Issue #282: the Upcoming reviews queue lists due words in card order, so it
// is collapsed by default and toggled by a remembered disclosure button.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");

function control(extra = {}) {
  const attributes = {};
  return {
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    ...extra
  };
}

const documentListeners = new Map();
const elements = new Map();
let revealClicks = 0;

globalThis.window = {
  __qtBridge: false,
  location: { search: "" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false, addEventListener() {} }; }
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};
class FakeElement {
  static [Symbol.hasInstance](value) {
    return value !== null && typeof value === "object";
  }
}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLButtonElement = FakeElement;
globalThis.HTMLInputElement = FakeElement;
globalThis.HTMLSelectElement = FakeElement;
globalThis.document = {
  activeElement: null,
  body: { contains() { return false; } },
  documentElement: {
    dataset: { platform: "desktop" },
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  },
  addEventListener(type, listener) {
    const listeners = documentListeners.get(type) || [];
    listeners.push(listener);
    documentListeners.set(type, listeners);
  },
  getElementById(id) { return elements.get(id) ?? null; },
  querySelector(selector) {
    return selector === '[data-review-action="toggle"]' ? { click() { revealClicks += 1; } } : null;
  },
  querySelectorAll() { return []; }
};

const { createDefaultState, normalizeState, replaceState, state } = await import("../../dist/web/js/state.js");
const { syncSettingsControls } = await import("../../dist/web/js/preferences.js");
const { bindGlobalActionEvents } = await import("../../dist/web/js/events/global-actions.js");
const { handleFlashcardKeys } = await import("../../dist/web/js/events/keyboard/flashcards-keys.js");

function resetState(preferences = {}) {
  const defaults = createDefaultState();
  replaceState({ ...defaults, currentView: "flashcards", preferences: { ...defaults.preferences, ...preferences } }, { save: false });
  elements.clear();
  elements.set("review-upcoming-toggle", control());
  elements.set("review-upcoming", control());
  revealClicks = 0;
}

function keyEvent(key, target) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target,
    preventDefault() { this.defaultPrevented = true; }
  };
}

const onToggle = { closest(selector) { return selector === "#review-upcoming-toggle" ? this : null; } };
const elsewhere = { closest() { return null; } };

describe("upcoming reviews toggle (#282)", () => {
  it("defaults to collapsed and only accepts a real true", () => {
    assert.equal(createDefaultState().preferences.reviewUpcomingVisible, false);
    const normalized = (value) => normalizeState({
      ...createDefaultState(),
      preferences: { reviewUpcomingVisible: value }
    }).preferences.reviewUpcomingVisible;
    assert.equal(normalized(true), true);
    assert.equal(normalized("yes"), false);
    assert.equal(normalized(1), false);
    assert.equal(normalized(undefined), false);
  });

  it("ships the queue hidden behind a disclosure button before scripts run", () => {
    const toggle = html.match(/<button\b[^>]*\bid="review-upcoming-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
    assert.match(toggle, /aria-expanded="false"/);
    assert.match(toggle, /aria-controls="review-upcoming"/);
    assert.match(toggle, /<span data-i18n="vocab.upcomingHeading">Upcoming reviews<\/span>/);
    assert.match(html, /<div id="review-upcoming" class="review-upcoming" hidden><\/div>/);
  });

  it("syncs the list visibility and aria-expanded from the preference", () => {
    resetState();
    syncSettingsControls();
    assert.equal(elements.get("review-upcoming").hidden, true);
    assert.equal(elements.get("review-upcoming-toggle").getAttribute("aria-expanded"), "false");

    state.preferences.reviewUpcomingVisible = true;
    syncSettingsControls();
    assert.equal(elements.get("review-upcoming").hidden, false);
    assert.equal(elements.get("review-upcoming-toggle").getAttribute("aria-expanded"), "true");
  });

  it("flips and remembers the preference on click", () => {
    resetState();
    bindGlobalActionEvents();
    const click = documentListeners.get("click").at(-1);
    const event = { composedPath() { return []; }, target: onToggle };

    click(event);
    assert.equal(state.preferences.reviewUpcomingVisible, true);
    assert.equal(elements.get("review-upcoming").hidden, false);

    click(event);
    assert.equal(state.preferences.reviewUpcomingVisible, false);
    assert.equal(elements.get("review-upcoming").hidden, true);
  });

  it("gives up focus after a pointer click so Enter still reveals the card", () => {
    resetState();
    bindGlobalActionEvents();
    const click = documentListeners.get("click").at(-1);
    let blurs = 0;
    const toggle = { ...onToggle, blur() { blurs += 1; } };

    click({ detail: 1, composedPath() { return []; }, target: toggle });
    assert.equal(state.preferences.reviewUpcomingVisible, true);
    assert.equal(blurs, 1);

    // Enter or Space on a keyboard-focused button clicks with detail 0.
    click({ detail: 0, composedPath() { return []; }, target: toggle });
    assert.equal(state.preferences.reviewUpcomingVisible, false);
    assert.equal(blurs, 1);
  });

  it("lets Enter and Space activate the focused toggle instead of the card", () => {
    resetState();
    for (const key of ["enter", " "]) {
      const event = keyEvent(key === "enter" ? "Enter" : " ", onToggle);
      assert.equal(handleFlashcardKeys(event, key), false, key);
      assert.equal(event.defaultPrevented, false, key);
    }
    assert.equal(revealClicks, 0);

    const reveal = keyEvent("Enter", elsewhere);
    assert.equal(handleFlashcardKeys(reveal, "enter"), true);
    assert.equal(reveal.defaultPrevented, true);
    assert.equal(revealClicks, 1);
  });
});
