import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { dispatchEvent: () => {}, __qtBridge: false };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { addEventListener: () => {}, getElementById: () => null };

const { getLearningColor, getSrsLevel, normalizeLearningColors, DEFAULT_LEARNING_COLORS } = await import("../../src/web/js/reader-colors.js");
const { isInTextReviewDue, scheduleFirstLearningReview } = await import("../../src/web/js/sm2.js");
const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
const { normalizeState } = await import("../../src/web/js/state/normalize.js");
const { state } = await import("../../src/web/js/state.js");
const { applyReviewGrade, renderReview } = await import("../../src/web/js/vocabulary/review-card.js");
const { handleReaderKeys } = await import("../../src/web/js/events/keyboard/reader-keys.js");
const { els } = await import("../../src/web/js/dom.js");

describe("learning colors", () => {
  it("enables learning colors, in-text reviews, and learning-only flashcards by default", () => {
    const defaults = createDefaultState().preferences;
    assert.equal(defaults.dynamicLearningColors, true);
    assert.equal(defaults.inTextReview, true);
    assert.equal(defaults.autoAddLearningOnly, true);
  });

  it("uses the five-level palette only when enabled", () => {
    const prefs = { dynamicLearningColors: true, learningColors: ["#101010", "#202020", "#303030", "#404040", "#505050"] };
    assert.equal(getSrsLevel({ repetition: 0 }), 1);
    assert.equal(getSrsLevel({ repetition: 4 }), 5);
    assert.equal(getSrsLevel({ repetition: 999 }), 5);
    assert.equal(getLearningColor({ repetition: 0 }, prefs), "#101010");
    assert.equal(getLearningColor({ repetition: 4 }, prefs), "#505050");
    assert.equal(getLearningColor({ repetition: 4 }, { ...prefs, dynamicLearningColors: false }), "");
  });

  it("normalizes malformed palettes and boolean preferences safely", () => {
    const restored = normalizeState({
      ...createDefaultState(),
      preferences: { learningColors: ["bad", "#123456"], inTextReview: "yes", dynamicLearningColors: 1 }
    });
    assert.deepEqual(normalizeLearningColors(restored.preferences.learningColors), [
      DEFAULT_LEARNING_COLORS[0], "#123456", ...DEFAULT_LEARNING_COLORS.slice(2)
    ]);
    assert.equal(restored.preferences.inTextReview, false);
    assert.equal(restored.preferences.dynamicLearningColors, false);
  });
});

describe("in-text SRS grading", () => {
  it("keeps new words out of flashcards when the learning-only default is enabled", () => {
    const today = "2026-06-23";
    const previousCard = els.reviewCard;
    els.reviewCard = { innerHTML: "" };
    state.preferences.autoAddLearningOnly = true;
    state.vocab = {
      fresh: { status: "new", nextDate: today },
      learning: { status: "learning", nextDate: today }
    };
    renderReview();
    assert.match(els.reviewCard.innerHTML, /learning/);
    assert.doesNotMatch(els.reviewCard.innerHTML, /fresh/);
    els.reviewCard = previousCard;
  });

  it("does not persist unchanged review state while rendering a card", () => {
    const previousCard = els.reviewCard;
    const previousSetItem = localStorage.setItem;
    let writes = 0;
    localStorage.setItem = () => { writes += 1; };
    els.reviewCard = { innerHTML: "" };
    state.preferences.autoAddLearningOnly = true;
    state.vocab = { learning: { status: "learning", nextDate: "2000-01-01" } };
    state.reviewIndex = 0;

    try {
      renderReview();
      assert.equal(writes, 0);
    } finally {
      localStorage.setItem = previousSetItem;
      els.reviewCard = previousCard;
    }
  });

  it("uses Enter to reveal and number keys to grade an in-text review", () => {
    const originalDocument = globalThis.document;
    const originalSelectedWord = state.selectedWord;
    let answerClicked = false;
    let gradeClicked = false;
    let prevented = 0;
    state.selectedWord = "wort";
    globalThis.document = {
      querySelector(selector) {
        if (selector === "[data-in-text-answer]") return { click: () => { answerClicked = true; } };
        return null;
      }
    };
    assert.equal(handleReaderKeys({ preventDefault: () => { prevented++; }, code: "Enter" }, "enter"), true);
    assert.equal(answerClicked, true);

    globalThis.document = {
      querySelector(selector) {
        if (selector === "[data-in-text-grade=\"4\"]") return { click: () => { gradeClicked = true; } };
        return null;
      }
    };
    assert.equal(handleReaderKeys({ preventDefault: () => { prevented++; }, code: "Digit4" }, "4"), true);
    assert.equal(gradeClicked, true);
    assert.equal(prevented, 2);
    state.selectedWord = originalSelectedWord;
    globalThis.document = originalDocument;
  });

  it("waits until the next day before prompting a newly learned word", () => {
    const entry = { status: "learning" };
    scheduleFirstLearningReview(entry, new Date("2026-06-23T12:00:00"));
    assert.equal(entry.nextDate, "2026-06-24");
    assert.equal(isInTextReviewDue(entry, "2026-06-23"), false);
    assert.equal(isInTextReviewDue(entry, "2026-06-24"), true);
  });

  const expectedEase = new Map([[1, 1.96], [2, 2.18], [3, 2.36], [4, 2.5], [5, 2.6]]);
  for (const quality of expectedEase.keys()) {
    it(`routes grade ${quality} through the existing SRS scheduler`, async () => {
      state.preferences.srsAlgorithm = "sm2";
      state.vocab = { wort: { status: "learning", repetition: 0, interval: 0, efactor: 2.5 } };
      const entry = await applyReviewGrade("wort", quality);
      assert.equal(entry.status, "learning");
      assert.equal(entry.repetition, quality < 3 ? 0 : 1);
      assert.equal(entry.interval, 1);
      assert.equal(entry.efactor, expectedEase.get(quality));
      assert.equal(getSrsLevel(entry), quality < 3 ? 1 : 2);
      assert.ok(entry.nextDate);
    });
  }

  it("promotes a repeatedly recalled word through the shared rule", async () => {
    state.preferences.srsAlgorithm = "sm2";
    state.vocab = { wort: { status: "learning", repetition: 1, interval: 1, efactor: 2.5 } };
    const entry = await applyReviewGrade("wort", 4);
    assert.equal(entry.repetition, 2);
    assert.equal(entry.status, "known");
    assert.equal(entry.knownAt, entry.updatedAt);
  });

  it("uses FSRS when that is the selected scheduler", async () => {
    state.preferences.srsAlgorithm = "fsrs";
    state.vocab = { wort: { status: "learning", repetition: 0, interval: 0, stability: 0, difficulty: 5 } };
    const entry = await applyReviewGrade("wort", 5);
    assert.equal(entry.srsAlgorithm, "fsrs");
    assert.equal(entry.repetition, 1);
    assert.ok(entry.stability > 0);
    assert.equal(getSrsLevel(entry), 2);
  });
});

describe("new interface copy", () => {
  for (const locale of ["en", "pl", "de", "es", "fr", "it", "ja", "ru", "uk"]) {
    it(`${locale} has every in-text review label`, () => {
      const data = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${locale}.json`, import.meta.url)));
      for (const key of ["dynamicLearningColors", "dynamicLearningColorsHint", "learningColorPalette", "learningColorLevel", "inTextReview", "inTextReviewHint"]) {
        assert.equal(typeof data.settings[key], "string", `${locale}.settings.${key}`);
      }
      for (const key of ["inTextPrompt", "showAnswer", "inTextRating", "inTextRecorded"]) {
        assert.equal(typeof data.sm2[key], "string", `${locale}.sm2.${key}`);
      }
      assert.equal(typeof data.import.mobileFileHint, "string", `${locale}.import.mobileFileHint`);
      assert.equal(typeof data.help.whatsNew, "string", `${locale}.help.whatsNew`);
      assert.equal(typeof data.help.readerKeys.inTextReview, "string", `${locale}.help.readerKeys.inTextReview`);
      assert.match(data.help.whatsNew, /1\.0\.2/, `${locale}.help.whatsNew version`);
      assert.match(data.help.version, /1\.0\.2/, `${locale}.help.version`);
      assert.match(data.help.creditSync, /Syncthing 2\.1\.0[\s\S]*MPL-2\.0/, `${locale}.help.creditSync`);
      assert.match(data.help.creditNotices, /THIRD-PARTY-NOTICES\.md/, `${locale}.help.creditNotices`);
    });
  }
});
