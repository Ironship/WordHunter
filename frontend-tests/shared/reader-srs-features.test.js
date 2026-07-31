import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {}, __qtBridge: false };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { addEventListener: () => {}, getElementById: () => null };

const { getLearningColor, getSrsLevel, normalizeLearningColors, DEFAULT_LEARNING_COLORS } = await import("../../dist/web/js/reader-colors.js");
const { applyReviewNative, isInTextReviewDue, scheduleFirstLearningReview } = await import("../../dist/web/js/sm2.js");
const { createDefaultState } = await import("../../dist/web/js/state/defaults.js");
const { normalizeState } = await import("../../dist/web/js/state/normalize.js");
const { applyBridgeSnapshotToState, replaceState, state } = await import("../../dist/web/js/state.js");
const { applyReviewGrade, gradeReview, renderReview, resetReviewPresentation } = await import("../../dist/web/js/vocabulary/review-card.js");
const { hideReviewAnswer, toggleReviewAnswer } = await import("../../dist/web/js/views/vocabulary.js");
const { handleReaderKeys } = await import("../../dist/web/js/events/keyboard/reader-keys.js");
const { stopSpeaking } = await import("../../dist/web/js/tts.js");
const { els } = await import("../../dist/web/js/dom.js");
const appVersion = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).version.replace("+", ".");

describe("learning colors", () => {
  it("enables learning colors, in-text reviews, and learning-only flashcards by default", () => {
    const defaults = createDefaultState().preferences;
    assert.equal(defaults.dynamicLearningColors, true);
    assert.equal(defaults.inTextReview, true);
    assert.equal(defaults.inTextReviewCompletedGuesses, 0);
    assert.equal(defaults.autoAddLearningOnly, true);
    assert.equal(defaults.autoTtsOnFlashcardOpen, true);
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

  it("normalizes persisted in-text prompt progress to the onboarding threshold", () => {
    for (const [value, expected] of [[undefined, 0], ["2.9", 2], [99, 3], [-4, 0], ["invalid", 0]]) {
      const raw = createDefaultState();
      raw.preferences.inTextReviewCompletedGuesses = value;
      assert.equal(normalizeState(raw).preferences.inTextReviewCompletedGuesses, expected);
    }
  });

  it("does not regress in-text onboarding progress when applying older sync snapshots", () => {
    const original = structuredClone(state._raw || state);
    window.__qtBridge = true;
    try {
      state.preferences.inTextReviewCompletedGuesses = 1;
      assert.equal(applyBridgeSnapshotToState({
        schemaVersion: 2,
        prefs: { ...original.preferences, inTextReviewCompletedGuesses: 3 },
        vocab: structuredClone(original.profiles),
        texts: [],
        hiddenBooks: []
      }, { preserveLocalUi: false }), true);
      assert.equal(state.preferences.inTextReviewCompletedGuesses, 3);

      for (const remoteValue of [1, undefined]) {
        const prefs = { ...original.preferences, theme: "classic-dark" };
        if (remoteValue !== undefined) prefs.inTextReviewCompletedGuesses = remoteValue;
        else delete prefs.inTextReviewCompletedGuesses;
        const snapshot = {
          schemaVersion: 2,
          prefs,
          vocab: structuredClone(original.profiles),
          texts: [],
          hiddenBooks: []
        };

        assert.equal(applyBridgeSnapshotToState(snapshot, { preserveLocalUi: false }), true);
        assert.equal(state.preferences.inTextReviewCompletedGuesses, 3);
        assert.equal(state.preferences.theme, "classic-dark");
      }
    } finally {
      replaceState(original, { save: false });
      delete window.__bridgeState;
      window.__qtBridge = false;
    }
  });
});

describe("in-text SRS grading", () => {
  function setActiveVocab(vocab) {
    state.profiles.de.vocab = vocab;
    state.vocab = state.profiles.de.vocab;
  }

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

  it("shows the article with the headword without leaking it on a reverse card", () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    const previousReverse = state.preferences.reviewReverse;
    els.reviewCard = { innerHTML: "" };
    state.vocab = {
      haus: {
        status: "learning",
        article: "das",
        translation: "house",
        examples: ["Das große Haus ist alt."],
        nextDate: "2000-01-01"
      }
    };
    state.reviewIndex = 0;

    try {
      hideReviewAnswer();
      state.preferences.reviewReverse = false;
      renderReview();
      assert.match(els.reviewCard.innerHTML, /das haus/);

      hideReviewAnswer();
      state.preferences.reviewReverse = true;
      renderReview();
      assert.doesNotMatch(els.reviewCard.innerHTML, />das haus</);
      assert.match(els.reviewCard.innerHTML, /„_____ große _____ ist alt\.”/i);
      assert.doesNotMatch(els.reviewCard.innerHTML, /Das\s+große/i);

      toggleReviewAnswer();
      renderReview();
      assert.match(els.reviewCard.innerHTML, />\s*das haus\s*</);
    } finally {
      hideReviewAnswer();
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
      state.preferences.reviewReverse = previousReverse;
    }
  });

  it("masks straight and typographic apostrophe articles on reverse cards", () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    const previousReverse = state.preferences.reviewReverse;
    els.reviewCard = { innerHTML: "" };
    state.vocab = {
      homme: {
        status: "learning",
        article: "l'",
        translation: "man",
        examples: ["L’homme arrive."],
        nextDate: "2000-01-01"
      }
    };
    state.reviewIndex = 0;

    try {
      hideReviewAnswer();
      state.preferences.reviewReverse = true;
      renderReview();
      assert.match(els.reviewCard.innerHTML, /„_____ arrive\.”/i);
      assert.doesNotMatch(els.reviewCard.innerHTML, /L['’]_____/i);
    } finally {
      hideReviewAnswer();
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
      state.preferences.reviewReverse = previousReverse;
    }
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

  it("renders a bounded, animated flashcard deck without changing review data", () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    const previousIndex = state.reviewIndex;
    els.reviewCard = { innerHTML: "" };
    state.preferences.autoAddLearningOnly = true;
    state.vocab = {
      alpha: { status: "learning", nextDate: "2000-01-01", repetition: 1, interval: 2 },
      beta: { status: "learning", nextDate: "2000-01-02", repetition: 3, interval: 8 }
    };

    try {
      state.reviewIndex = 0;
      renderReview("next");
      assert.match(els.reviewCard.innerHTML, /class="flashcard-wrap flashcard-enter-next"/);
      assert.match(els.reviewCard.innerHTML, /data-review-card-surface/);
      assert.match(els.reviewCard.innerHTML, /id="btn-flashcard-prev"[^>]*disabled/);
      assert.doesNotMatch(els.reviewCard.innerHTML, /id="btn-flashcard-next"[^>]*disabled/);
      assert.match(els.reviewCard.innerHTML, /aria-expanded="false" aria-controls="review-card-answer"/);
      assert.match(els.reviewCard.innerHTML, /class="flashcard-navigation"/);
      toggleReviewAnswer();
      renderReview();
      assert.equal((els.reviewCard.innerHTML.match(/data-sm2-grade="[1-5]"/g) || []).length, 5);
      assert.doesNotMatch(els.reviewCard.innerHTML, /data-sm2-grade="0"/);
      hideReviewAnswer();

      state.reviewIndex = 1;
      renderReview("previous");
      assert.match(els.reviewCard.innerHTML, /class="flashcard-wrap flashcard-enter-previous"/);
      assert.match(els.reviewCard.innerHTML, /id="btn-flashcard-next"[^>]*disabled/);
      assert.deepEqual(state.vocab.beta, { status: "learning", nextDate: "2000-01-02", repetition: 3, interval: 8 });
    } finally {
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
      state.reviewIndex = previousIndex;
    }
  });

  it("keeps a shuffled review session stable across rerenders", () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    const previousIndex = state.reviewIndex;
    els.reviewCard = { innerHTML: "" };
    state.preferences.autoAddLearningOnly = true;
    state.vocab = Object.fromEntries(["shuffle-a", "shuffle-b", "shuffle-c", "shuffle-d"].map((word) => [
      word,
      { status: "learning", nextDate: "2000-01-01", repetition: 1, interval: 2 }
    ]));

    try {
      const order = [];
      for (let index = 0; index < 4; index += 1) {
        state.reviewIndex = index;
        renderReview();
        order.push(els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1]);
      }
      assert.deepEqual(new Set(order), new Set(Object.keys(state.vocab)));
      state.reviewIndex = 2;
      renderReview();
      const first = els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1];
      renderReview();
      const second = els.reviewCard.innerHTML.match(/data-dict-word="([^"]+)"/)?.[1];
      assert.equal(second, first);
    } finally {
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
      state.reviewIndex = previousIndex;
    }
  });

  it("renders an accessible square image-removal control", () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    els.reviewCard = { innerHTML: "" };
    state.preferences.autoAddLearningOnly = true;
    state.vocab = {
      pictured: { word: "Pictured", status: "learning", nextDate: "2000-01-01", imageUrl: "data:image/png;base64,AA==" }
    };

    try {
      renderReview();
      assert.match(els.reviewCard.innerHTML, /class="word-image-remove review-image-remove"/);
      assert.match(els.reviewCard.innerHTML, /data-action="remove-image"[^>]*aria-label="[^"]+"/);
      assert.match(els.reviewCard.innerHTML, /alt="Pictured"/);
    } finally {
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
    }
  });

  it("reads each newly presented flashcard once when automatic TTS is enabled", async () => {
    const previousCard = els.reviewCard;
    const previousVocab = state.vocab;
    const previousView = state.currentView;
    const previousAutoTts = state.preferences.autoTtsOnFlashcardOpen;
    const spoken = [];
    els.reviewCard = { innerHTML: "" };
    state.currentView = "flashcards";
    state.preferences.autoAddLearningOnly = true;
    state.preferences.autoTtsOnFlashcardOpen = true;
    state.vocab = { "spoken-card": { word: "Spoken card", status: "learning", nextDate: "2000-01-01" } };
    window.WordHunterAndroid = {
      speak(text) { spoken.push(text); return true; }
    };

    try {
      resetReviewPresentation();
      renderReview();
      await Promise.resolve();
      renderReview();
      await Promise.resolve();
      assert.deepEqual(spoken, ["Spoken card"]);

      state.preferences.autoTtsOnFlashcardOpen = false;
      state.vocab = { "silent-card": { status: "learning", nextDate: "2000-01-01" } };
      renderReview();
      await Promise.resolve();
      assert.deepEqual(spoken, ["Spoken card"]);
    } finally {
      stopSpeaking();
      delete window.WordHunterAndroid;
      els.reviewCard = previousCard;
      state.vocab = previousVocab;
      state.currentView = previousView;
      state.preferences.autoTtsOnFlashcardOpen = previousAutoTts;
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

  it("does not prompt a word added today even when stale data says it is due", () => {
    const entry = {
      status: "learning",
      addedAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
      repetition: 0,
      nextDate: "2026-07-17"
    };

    assert.equal(isInTextReviewDue(entry, "2026-07-17"), false);
    assert.equal(isInTextReviewDue(entry, "2026-07-18"), true);
  });

  const expectedEase = new Map([[1, 1.96], [2, 2.18], [3, 2.36], [4, 2.5], [5, 2.6]]);
  for (const quality of expectedEase.keys()) {
    it(`routes grade ${quality} through the existing SRS scheduler`, async () => {
      state.preferences.srsAlgorithm = "sm2";
      setActiveVocab({ wort: { status: "learning", repetition: 0, interval: 0, efactor: 2.5 } });
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
    setActiveVocab({ wort: { status: "learning", repetition: 1, interval: 1, efactor: 2.5 } });
    const entry = await applyReviewGrade("wort", 4);
    assert.equal(entry.repetition, 2);
    assert.equal(entry.status, "known");
    assert.equal(entry.knownAt, entry.updatedAt);
  });

  it("uses FSRS when that is the selected scheduler", async () => {
    state.preferences.srsAlgorithm = "fsrs";
    setActiveVocab({ wort: { status: "learning", repetition: 0, interval: 0, stability: 0, difficulty: 5 } });
    const entry = await applyReviewGrade("wort", 5);
    assert.equal(entry.srsAlgorithm, "fsrs");
    assert.equal(entry.repetition, 1);
    assert.ok(entry.stability > 0);
    assert.equal(getSrsLevel(entry), 2);
  });

  it("keeps the first FSRS interval when a new card enters Learning", async () => {
    state.preferences.srsAlgorithm = "fsrs";
    setActiveVocab({ wort: { status: "new", repetition: 0, interval: 0, stability: 0, difficulty: 5 } });

    const entry = await applyReviewGrade("wort", 5);

    assert.equal(entry.interval, 7);
    const expected = new Date(entry.lastReviewedAt);
    expected.setDate(expected.getDate() + entry.interval);
    const expectedDate = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`;
    assert.equal(entry.status, "learning");
    assert.equal(entry.nextDate, expectedDate);
  });

  it("falls back to local scheduling when the native review request times out", async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    window.__qtBridge = true;
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 1;
    };
    globalThis.clearTimeout = () => {};
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });

    try {
      const reviewed = await applyReviewNative(
        { status: "learning", repetition: 0, interval: 0, efactor: 2.5 },
        4,
        new Date("2026-07-15T12:00:00Z"),
        "sm2"
      );
      assert.equal(reviewed.repetition, 1);
      assert.equal(reviewed.interval, 1);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      delete window.__qtBridge;
    }
  });

  it("applies a delayed native grade to the current vocabulary entry", async () => {
    const originalFetch = globalThis.fetch;
    window.__qtBridge = true;
    window.WH_TOKEN = "test-token";
    state.preferences.srsAlgorithm = "sm2";
    state.vocab = { wort: { status: "learning", repetition: 0, interval: 0, efactor: 2.5 } };
    let resolveReview;
    globalThis.fetch = (url) => {
      if (url === "/__srs/review") {
        return new Promise((resolve) => { resolveReview = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    };

    try {
      const pendingGrade = applyReviewGrade("wort", 4);
      const replacement = { status: "learning", repetition: 0, interval: 0, efactor: 2.5, note: "synced" };
      state.profiles.de.vocab = { wort: replacement };
      state.vocab = state.profiles.de.vocab;
      resolveReview({
        ok: true,
        json: async () => ({ repetition: 1, interval: 1, efactor: 2.5, nextDate: "2026-07-15", srsAlgorithm: "sm2" })
      });

      const entry = await pendingGrade;
      assert.equal(entry, state.vocab.wort);
      assert.equal(entry.repetition, 1);
      assert.equal(entry.note, "synced");
    } finally {
      globalThis.fetch = originalFetch;
      delete window.__qtBridge;
      delete window.WH_TOKEN;
    }
  });

  it("accepts only one flashcard grade while native scheduling is pending", async () => {
    const originalFetch = globalThis.fetch;
    const previousCard = els.reviewCard;
    window.__qtBridge = true;
    window.WH_TOKEN = "test-token";
    state.preferences.srsAlgorithm = "sm2";
    setActiveVocab({ wort: { status: "learning", repetition: 0, interval: 0, efactor: 2.5 } });
    let resolveReview;
    let reviewRequests = 0;
    els.reviewCard = {
      innerHTML: "",
      setAttribute() {},
      removeAttribute() {},
      querySelectorAll() { return []; }
    };
    globalThis.fetch = (url) => {
      if (url === "/__srs/review") {
        reviewRequests += 1;
        return new Promise((resolve) => { resolveReview = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    };

    try {
      const first = gradeReview("wort", 3);
      await gradeReview("wort", 5);
      assert.equal(reviewRequests, 1);
      resolveReview({
        ok: true,
        json: async () => ({ repetition: 1, interval: 1, efactor: 2.36, nextDate: "2026-07-15", srsAlgorithm: "sm2" })
      });
      await first;
      assert.equal(state.vocab.wort.repetition, 1);
    } finally {
      els.reviewCard = previousCard;
      globalThis.fetch = originalFetch;
      delete window.__qtBridge;
      delete window.WH_TOKEN;
    }
  });

  it("does not overwrite a status changed while a native grade is pending", async () => {
    const originalFetch = globalThis.fetch;
    window.__qtBridge = true;
    window.WH_TOKEN = "test-token";
    state.preferences.srsAlgorithm = "sm2";
    setActiveVocab({ wort: { status: "learning", repetition: 0, interval: 0, efactor: 2.5 } });
    let resolveReview;
    globalThis.fetch = (url) => {
      if (url === "/__srs/review") {
        return new Promise((resolve) => { resolveReview = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    };

    try {
      const pendingGrade = applyReviewGrade("wort", 2);
      state.vocab.wort.status = "ignored";
      state.vocab.wort.updatedAt = "2026-07-14T10:02:00.000Z";
      resolveReview({
        ok: true,
        json: async () => ({ repetition: 0, interval: 1, efactor: 2.18, nextDate: "2026-07-15", srsAlgorithm: "sm2" })
      });

      assert.equal(await pendingGrade, null);
      assert.equal(state.vocab.wort.status, "ignored");
      assert.equal(state.vocab.wort.interval, 0);
    } finally {
      globalThis.fetch = originalFetch;
      delete window.__qtBridge;
      delete window.WH_TOKEN;
    }
  });
});

describe("new interface copy", () => {
  for (const locale of ["en", "pl", "de", "es", "fr", "it", "ja", "ru", "uk"]) {
    it(`${locale} has every in-text review label`, () => {
      const data = JSON.parse(readFileSync(new URL(`../../dist/web/i18n/${locale}.json`, import.meta.url)));
      for (const key of ["dynamicLearningColors", "dynamicLearningColorsHint", "learningColorPalette", "learningColorLevel", "inTextReview", "inTextReviewHint"]) {
        assert.equal(typeof data.settings[key], "string", `${locale}.settings.${key}`);
      }
      for (const key of ["inTextPrompt", "showAnswer", "inTextRating", "inTextRecorded"]) {
        assert.equal(typeof data.sm2[key], "string", `${locale}.sm2.${key}`);
      }
      assert.equal(typeof data.import.mobileFileHint, "string", `${locale}.import.mobileFileHint`);
      assert.equal(typeof data.import.pdfPocketScanTitle, "string", `${locale}.import.pdfPocketScanTitle`);
      assert.equal(typeof data.import.pdfPocketScanBody, "string", `${locale}.import.pdfPocketScanBody`);
      assert.equal(typeof data.help.whatsNew, "string", `${locale}.help.whatsNew`);
      assert.equal(typeof data.help.readerKeys.inTextReview, "string", `${locale}.help.readerKeys.inTextReview`);
      assert.ok(data.help.whatsNew.includes(appVersion), `${locale}.help.whatsNew version`);
      assert.ok(data.help.version.includes(appVersion), `${locale}.help.version`);
      assert.match(data.help.creditNotices, /THIRD-PARTY-NOTICES\.md/, `${locale}.help.creditNotices`);
    });
  }
});
