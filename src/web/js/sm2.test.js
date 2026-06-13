import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSM2,
  calculateFSRS,
  applyReview,
  ensureSM2Fields,
  isDue,
  todayISO,
  addDaysISO,
  SM2_DEFAULTS,
  FSRS_DEFAULTS,
} from "./sm2.js";

// =============================================================================
// SM-2 (SuperMemo 2)
// =============================================================================
// Formulas verified against https://en.wikipedia.org/wiki/SuperMemo#Description_of_SM-2_algorithm
//
// nextEfactor = efactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
// nextEfactor < 1.3 → clamped to 1.3
//
// q >= 3:
//   repetition 0 → interval 1
//   repetition 1 → interval 6
//   repetition 2+ → interval = round(interval * efactor)
//   repetition += 1
// q < 3:
//   repetition = 0, interval = 1
// =============================================================================

describe("SM-2", () => {
  it("zwraca domyślne wartości dla undefined/brak prev", () => {
    const r = calculateSM2(4, undefined);
    assert.equal(r.repetition, 1);
    assert.equal(r.interval, 1);
    assert.equal(r.efactor, 2.5000);
  });

  it("pierwsza powtórka z q=5: interval=1, efactor=2.6000", () => {
    // efactor = 2.5 + (0.1 - (5-5)*(0.08 + (5-5)*0.02)) = 2.5 + 0.1 = 2.6
    const r = calculateSM2(5, SM2_DEFAULTS);
    assert.equal(r.repetition, 1);
    assert.equal(r.interval, 1);
    assert.equal(r.efactor, 2.6000);
  });

  it("q=4 nie zmienia efactor (2.5 → 2.5)", () => {
    // efactor = 2.5 + (0.1 - (5-4)*(0.08 + (5-4)*0.02)) = 2.5 + (0.1 - 0.1) = 2.5
    const r = calculateSM2(4, SM2_DEFAULTS);
    assert.equal(r.efactor, 2.5000);
  });

  it("q=3 obniża efactor (2.5 → 2.36)", () => {
    // efactor = 2.5 + (0.1 - 2*(0.08 + 2*0.02)) = 2.5 + (0.1 - 0.24) = 2.36
    const r = calculateSM2(3, SM2_DEFAULTS);
    assert.equal(r.efactor, 2.3600);
  });

  it("q=2 obniża efactor (2.5 → 2.18)", () => {
    // efactor = 2.5 + (0.1 - 3*(0.08 + 3*0.02)) = 2.5 + (0.1 - 0.42) = 2.18
    const r = calculateSM2(2, SM2_DEFAULTS);
    assert.equal(r.efactor, 2.1800);
  });

  it("q=1 obniża efactor (2.5 → 1.96)", () => {
    // efactor = 2.5 + (0.1 - 4*(0.08 + 4*0.02)) = 2.5 + (0.1 - 0.64) = 1.96
    const r = calculateSM2(1, SM2_DEFAULTS);
    assert.equal(r.efactor, 1.9600);
  });

  it("q=0 obniża efactor (2.5 → 1.70)", () => {
    // efactor = 2.5 + (0.1 - 5*(0.08 + 5*0.02)) = 2.5 + (0.1 - 0.9) = 1.70
    const r = calculateSM2(0, SM2_DEFAULTS);
    assert.equal(r.efactor, 1.7000);
  });

  it("efactor nie spada poniżej 1.3", () => {
    const r = calculateSM2(0, { repetition: 0, interval: 0, efactor: 1.3 });
    assert.equal(r.efactor, 1.3000);
  });

  it("repetition=0 → interval=1, repetition=1 → interval=6", () => {
    const r1 = calculateSM2(4, { repetition: 0, interval: 0, efactor: 2.5 });
    assert.equal(r1.interval, 1);
    const r2 = calculateSM2(4, { repetition: 1, interval: 1, efactor: 2.5 });
    assert.equal(r2.interval, 6);
  });

  it("repetition=2+ → interval = round(interval * efactor)", () => {
    // 6 * 2.5 = 15
    const r = calculateSM2(4, { repetition: 2, interval: 6, efactor: 2.5 });
    assert.equal(r.interval, 15);
    assert.equal(r.repetition, 3);

    // 15 * 2.5 = 37.5 → round → 38
    const r2 = calculateSM2(4, { repetition: 3, interval: 15, efactor: 2.5 });
    assert.equal(r2.interval, 38);
    assert.equal(r2.repetition, 4);
  });

  it("q<3 resetuje repetition do 0 i interval do 1", () => {
    const r = calculateSM2(1, { repetition: 5, interval: 100, efactor: 2.5 });
    assert.equal(r.repetition, 0);
    assert.equal(r.interval, 1);
    assert(r.efactor < 2.5);
  });

  it("quality jest przycinane do zakresu 0..5", () => {
    const hi = calculateSM2(99, SM2_DEFAULTS);
    assert.equal(hi.repetition, 1);

    const lo = calculateSM2(-1, SM2_DEFAULTS);
    assert.equal(lo.repetition, 0);
  });

  it("NaN quality jest obsługiwane (traktowane jako 0)", () => {
    const r = calculateSM2(NaN, SM2_DEFAULTS);
    assert.equal(r.repetition, 0);
    assert.equal(r.interval, 1);
    assert.equal(r.efactor, 1.7000);
  });

  it("interval rośnie geometrycznie — seria q=4 (stały efactor 2.5)", () => {
    let prev = SM2_DEFAULTS;
    prev = calculateSM2(4, prev);
    assert.equal(prev.interval, 1);
    prev = calculateSM2(4, prev);
    assert.equal(prev.interval, 6);
    prev = calculateSM2(4, prev);
    assert.equal(prev.interval, 15);
    prev = calculateSM2(4, prev);
    assert.equal(prev.interval, 38);
  });
});

// =============================================================================
// FSRS
// =============================================================================
// First review stabilities: again=1, hard=2, good=4, easy=7
// difficulty starts at 5; delta: again+1.15, hard+0.45, good-0.15, easy-0.65
// Non-first again: max(1, stability * (0.45 + 0.2 * retrievability))
// Non-first good/hard/easy: stability * ratingBoost * difficultyBoost * overdueBoost
//   hard capped at stability * 1.6
// interval (non-again): max(1, round(nextStability * desiredRetention/0.9))
//   with desiredRetention=0.9: max(1, round(nextStability))
// =============================================================================

describe("FSRS", () => {
  const NOW = new Date("2025-01-15T12:00:00Z");

  it("pierwsza powtórka: stabilności wg ratingu", () => {
    assert.equal(calculateFSRS(1, {}, NOW).stability, 1.00);
    assert.equal(calculateFSRS(3, {}, NOW).stability, 2.00);
    assert.equal(calculateFSRS(4, {}, NOW).stability, 4.00);
    assert.equal(calculateFSRS(5, {}, NOW).stability, 7.00);
  });

  it("pierwsza powtórka: difficulty wg ratingu", () => {
    // start: 5; delta: again+1.15, hard+0.45, good-0.15, easy-0.65
    assert.equal(calculateFSRS(0, {}, NOW).difficulty, 6.15);
    assert.equal(calculateFSRS(3, {}, NOW).difficulty, 5.45);
    assert.equal(calculateFSRS(4, {}, NOW).difficulty, 4.85);
    assert.equal(calculateFSRS(5, {}, NOW).difficulty, 4.35);
  });

  it("pierwsza powtórka: interval = round(stability) dla non-again", () => {
    assert.equal(calculateFSRS(0, {}, NOW).interval, 1);   // again
    assert.equal(calculateFSRS(3, {}, NOW).interval, 2);   // hard=2
    assert.equal(calculateFSRS(4, {}, NOW).interval, 4);   // good=4
    assert.equal(calculateFSRS(5, {}, NOW).interval, 7);   // easy=7
  });

  it("again resetuje repetition do 0 i interval do 1", () => {
    const r = calculateFSRS(0, { repetition: 5, interval: 30, stability: 10, difficulty: 5, lastReviewedAt: "2025-01-01T00:00:00Z" }, NOW);
    assert.equal(r.repetition, 0);
    assert.equal(r.interval, 1);
  });

  it("good inkrementuje repetition", () => {
    const r = calculateFSRS(4, { repetition: 2, interval: 10, stability: 8, difficulty: 5, lastReviewedAt: "2025-01-01T00:00:00Z" }, NOW);
    assert.equal(r.repetition, 3);
  });

  it("non-first again: max(1, stability * (0.45 + 0.2 * retrievability))", () => {
    // same-day: retrievability=1 → 0.45 + 0.2 = 0.65 → 10 * 0.65 = 6.5
    const prev = { repetition: 2, interval: 10, stability: 10, difficulty: 5, lastReviewedAt: NOW.toISOString() };
    const r = calculateFSRS(0, prev, NOW);
    assert.equal(r.stability, 6.50);
    assert.equal(r.interval, 1);
  });

  it("non-first good: uwzględnia ratingBoost, difficultyBoost, overdueBoost", () => {
    // same-day good: retrievability=1, overdueBoost=1
    // difficultyBoost = 1 + (10-5)/12 = 17/12 ≈ 1.41667
    // nextStability = 8 * 2.25 * 17/12 * 1 = 8 * 2.25 * 1.41667 = 25.5
    const prev = { repetition: 2, interval: 10, stability: 8, difficulty: 5, lastReviewedAt: NOW.toISOString() };
    const r = calculateFSRS(4, prev, NOW);
    // 8 * 2.25 * 17/12 = 25.5
    assert.equal(r.stability, 25.50);
  });

  it("hard jest capped do stability * 1.6", () => {
    // same-day hard: retrievability=1, overdueBoost=1
    // difficultyBoost = 1 + (10-5)/12 = 17/12
    // nextStability = stability * 1.2 * 17/12 = stability * 1.7
    // cap: stability * 1.6 → 1.6 wygrywa
    const prev = { repetition: 2, interval: 10, stability: 10, difficulty: 5, lastReviewedAt: NOW.toISOString() };
    const r = calculateFSRS(3, prev, NOW);
    assert.equal(r.stability, 16.00);
  });

  it("difficulty jest clamped 1..10", () => {
    for (let q = 0; q <= 5; q++) {
      const r = calculateFSRS(q, { repetition: 3, interval: 20, stability: 15, difficulty: 5, lastReviewedAt: NOW.toISOString() }, NOW);
      assert(r.difficulty >= 1 && r.difficulty <= 10, `difficulty ${r.difficulty} poza zakresem dla q=${q}`);
    }
  });

  it("obniża difficulty przy dobrych ratingach, podnosi przy złych", () => {
    const prev = { repetition: 3, interval: 20, stability: 15, difficulty: 5, lastReviewedAt: NOW.toISOString() };
    const again = calculateFSRS(0, prev, NOW);
    assert.equal(again.difficulty, 6.15);
    const good = calculateFSRS(4, prev, NOW);
    assert.equal(good.difficulty, 4.85);
    const easy = calculateFSRS(5, prev, NOW);
    assert.equal(easy.difficulty, 4.35);
  });

  it("obsługuje stability=0 (first review path)", () => {
    const r = calculateFSRS(3, { repetition: 0, interval: 0, stability: 0, difficulty: 5 }, NOW);
    assert.equal(r.stability, 2.00);
  });

  it("elapsedDaysSince zwraca 0 dla braku lastReviewedAt", () => {
    const r = calculateFSRS(4, { repetition: 0, interval: 0, stability: 0, difficulty: 5 }, NOW);
    assert(r.stability === 4.00);
  });
});

// =============================================================================
// applyReview
// =============================================================================

describe("applyReview", () => {
  const NOW = new Date("2025-01-15T12:00:00Z");

  it("zapisuje nextDate = addDaysISO(interval) i lastReviewedAt", () => {
    const entry = { word: "test" };
    applyReview(entry, 4, NOW, "sm2");
    assert.equal(entry.interval, 1);
    assert.equal(entry.nextDate, "2025-01-16");
    assert.equal(entry.lastReviewedAt, NOW.toISOString());
    assert.equal(entry.srsAlgorithm, "sm2");
  });

  it("zapisuje stability/difficulty dla FSRS", () => {
    const entry = { word: "test" };
    applyReview(entry, 4, NOW, "fsrs");
    assert.equal(entry.srsAlgorithm, "fsrs");
    assert.equal(typeof entry.stability, "number");
    assert(Number.isFinite(entry.difficulty));
    assert.equal(entry.nextDate, "2025-01-19"); // interval=4 → +4 dni
  });

  it("nieznany algorytm = domyślnie SM-2", () => {
    const entry = { word: "test" };
    applyReview(entry, 4, NOW, "invalid");
    assert.equal(entry.srsAlgorithm, "sm2");
    assert(!("stability" in entry) || entry.stability === 0);
  });
});

// =============================================================================
// ensureSM2Fields
// =============================================================================

describe("ensureSM2Fields", () => {
  it("uzupełnia brakujące pola domyślnymi", () => {
    const entry = { nextDate: "2025-02-01" };
    ensureSM2Fields(entry);
    assert.equal(entry.interval, SM2_DEFAULTS.interval);
    assert.equal(entry.repetition, SM2_DEFAULTS.repetition);
    assert.equal(entry.efactor, SM2_DEFAULTS.efactor);
    assert.equal(entry.srsAlgorithm, "sm2");
    // nextDate nie jest nadpisywany
    assert.equal(entry.nextDate, "2025-02-01");
  });

  it("nie nadpisuje istniejących pól", () => {
    const entry = {
      word: "test",
      interval: 10,
      repetition: 3,
      efactor: 2.5,
      stability: 5,
      difficulty: 5,
      nextDate: "2025-02-01",
      srsAlgorithm: "sm2"
    };
    ensureSM2Fields(entry);
    assert.equal(entry.interval, 10);
    assert.equal(entry.repetition, 3);
    assert.equal(entry.efactor, 2.5);
    assert.equal(entry.nextDate, "2025-02-01");
  });
});

// =============================================================================
// Date utilities
// =============================================================================

describe("todayISO", () => {
  it("zwraca YYYY-MM-DD dla podanej daty", () => {
    assert.equal(todayISO(new Date(2025, 0, 15)), "2025-01-15");
    assert.equal(todayISO(new Date(2025, 11, 31)), "2025-12-31");
  });
});

describe("addDaysISO", () => {
  it("dodaje dni", () => {
    assert.equal(addDaysISO(0, new Date(2025, 0, 15)), "2025-01-15");
    assert.equal(addDaysISO(1, new Date(2025, 0, 15)), "2025-01-16");
    assert.equal(addDaysISO(30, new Date(2025, 0, 15)), "2025-02-14");
  });

  it("nie zezwala na ujemne dni (clamp do 0)", () => {
    assert.equal(addDaysISO(-5, new Date(2025, 0, 15)), "2025-01-15");
  });
});

describe("isDue", () => {
  it("null/undefined = natychmiast zaległe", () => {
    assert.equal(isDue(null), true);
    assert.equal(isDue(undefined), true);
  });

  it("przeszła data = zaległe", () => {
    assert.equal(isDue("2025-01-01", "2025-01-15"), true);
  });

  it("dzisiejsza data = zaległe (≤)", () => {
    assert.equal(isDue("2025-01-15", "2025-01-15"), true);
  });

  it("przyszła data = niezaległe", () => {
    assert.equal(isDue("2025-01-20", "2025-01-15"), false);
  });
});
