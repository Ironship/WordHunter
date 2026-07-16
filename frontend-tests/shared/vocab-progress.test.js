import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "" };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const {
  buildAddedOverTimeBins,
  buildKnownLearningWordSeries,
  buildKnownWordSeries,
  formatVocabProgressDate,
  getCefrThresholds,
  getCurrentLevel
} = await import("../../dist/web/js/graphs/charts.js");

describe("vocabulary CEFR progress", () => {
  it("uses language-specific thresholds", () => {
    const japanese = getCefrThresholds("ja");

    assert.deepEqual(japanese, [300, 800, 1500, 3000, 6000, 10000]);
    assert.equal(getCurrentLevel(799, japanese), "A1");
    assert.equal(getCurrentLevel(800, japanese), "A2");
  });

  it("keeps undated known words in the progress baseline", () => {
    const series = buildKnownWordSeries([
      { status: "known" },
      { status: "known", updatedAt: "2026-01-05T00:00:00.000Z" },
      { status: "learning", updatedAt: "2026-01-06T00:00:00.000Z" }
    ], 120, Date.parse("2026-01-10T00:00:00.000Z"));

    assert.equal(series[0].val, 1);
    assert.equal(series.at(-1).val, 2);
  });

  it("builds a projected line from known plus learning words", () => {
    const series = buildKnownLearningWordSeries([
      { status: "known", knownAt: "2026-01-05T00:00:00.000Z" },
      { status: "learning", updatedAt: "2026-01-06T00:00:00.000Z" },
      { status: "new", updatedAt: "2026-01-07T00:00:00.000Z" }
    ], 120, Date.parse("2026-01-10T00:00:00.000Z"));

    assert.equal(series.at(-1).val, 2);
  });

  it("shows years on long-running progress axes", () => {
    const span = 900 * 24 * 60 * 60 * 1000;

    assert.equal(formatVocabProgressDate(Date.parse("2024-01-05T00:00:00.000Z"), span, "en-US"), "Jan 2024");
  });

  it("keeps old cards in all-time added-over-time bins", () => {
    const entries = [
      { status: "known", addedAt: "2022-03-01T00:00:00.000Z" },
      { status: "learning", addedAt: "2026-06-01T00:00:00.000Z" }
    ];
    const now = new Date("2026-06-25T00:00:00.000Z");

    assert.equal(buildAddedOverTimeBins(entries, false, now).some(bin => bin.label === "2022"), false);
    assert.equal(buildAddedOverTimeBins(entries, true, now).find(bin => bin.label === "2022").val, 1);
  });
});
