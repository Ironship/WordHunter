import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createDefaultState } from "../../dist/web/js/state/defaults.js";
import { normalizeState } from "../../dist/web/js/state/normalize.js";

describe("vocabulary case identity migration", () => {
  it("merges case and normalization variants without losing preferred spelling or metadata", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "de" },
      profiles: {
        de: {
          vocab: {
            AM: {
              word: "AM",
              status: "learning",
              statusUpdatedAt: "2026-01-01T00:00:00.000Z",
              translation: "new metadata",
              note: "edited later",
              examples: ["AM Morgen."],
              repetition: 9,
              interval: 30,
              efactor: 2.1,
              stability: 20,
              difficulty: 3,
              srsAlgorithm: "fsrs",
              nextDate: "2026-04-01",
              lastReviewedAt: "2026-03-01T00:00:00.000Z",
              updatedAt: "2026-04-01T00:00:00.000Z"
            },
            Am: {
              word: "Am",
              status: "known",
              statusUpdatedAt: "2026-02-01T00:00:00.000Z",
              translation: "at the",
              examples: ["Am Abend."],
              repetition: 3,
              interval: 6,
              lastReviewedAt: "2026-02-01T00:00:00.000Z",
              updatedAt: "2026-02-01T00:00:00.000Z"
            },
            am: {
              status: "new",
              note: "legacy note",
              examples: [],
              updatedAt: "2025-01-01T00:00:00.000Z"
            }
          },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.deepEqual(Object.keys(normalized.vocab), ["am"]);
    assert.equal(normalized.vocab.am.word, "AM");
    assert.equal(normalized.vocab.am.status, "known");
    assert.equal(normalized.vocab.am.statusUpdatedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(normalized.vocab.am.translation, "new metadata");
    assert.equal(normalized.vocab.am.note, "edited later");
    assert.equal(normalized.vocab.am.repetition, 9);
    assert.equal(normalized.vocab.am.interval, 30);
    assert.equal(normalized.vocab.am.lastReviewedAt, "2026-03-01T00:00:00.000Z");
    assert.deepEqual(normalized.vocab.am.examples, ["AM Morgen.", "Am Abend."]);
  });

  it("collapses canonical-equivalent Unicode spellings", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "fr" },
      profiles: {
        fr: {
          vocab: {
            "CAFÉ": { status: "known", translation: "coffee" },
            "Cafe\u0301": { status: "learning", note: "decomposed" }
          },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.deepEqual(Object.keys(normalized.vocab), ["café"]);
    assert.equal(normalized.vocab["café"].translation, "coffee");
    assert.equal(normalized.vocab["café"].note, "decomposed");
  });

  it("rekeys the other profile from preferred spelling when its source locale changes", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "other" },
      profiles: {
        other: {
          vocab: { i: { word: "I", status: "known", translation: "dotless" } },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: { translationSourceLanguage: "tr_TR" }
        }
      }
    });

    assert.deepEqual(Object.keys(normalized.vocab), ["ı"]);
    assert.equal(normalized.vocab["ı"].word, "I");
  });

  it("canonicalizes stale selectedWord to the normalized vocab key", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "de" },
      selectedWord: "AM",
      profiles: {
        de: {
          vocab: { AM: { status: "known", translation: "morning" } },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.equal(normalized.selectedWord, "am");
  });

  it("clears selectedWord when no canonical match exists", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "de" },
      selectedWord: "XYZ",
      selectedWordIndex: 5,
      profiles: {
        de: {
          vocab: {},
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.equal(normalized.selectedWord, null);
    assert.equal(normalized.selectedWordIndex, null);
  });

  it("picks addedAt/updatedAt by parsed instant not lexicographic string order", () => {
    const defaults = createDefaultState();
    const normalized = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "de" },
      profiles: {
        de: {
          vocab: {
            haus: { status: "known", addedAt: "2026-07-25T10:00:00+02:00", updatedAt: "2026-07-25T08:00:00Z" },
            Haus: { status: "known", addedAt: "2026-07-25T06:00:00-05:00", updatedAt: "2026-07-25T14:00:00+02:00" }
          },
          customTexts: [],
          userBooks: [],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.deepEqual(Object.keys(normalized.vocab), ["haus"]);
    assert.equal(normalized.vocab.haus.addedAt, "2026-07-25T10:00:00+02:00");
    assert.equal(normalized.vocab.haus.updatedAt, "2026-07-25T14:00:00+02:00");
  });
});
