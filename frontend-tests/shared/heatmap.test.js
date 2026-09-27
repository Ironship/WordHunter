import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildHeatmapActivityCounts } = await import("../../dist/web/js/graphs/helpers.js");
const { createDefaultState, replaceState, switchLearningLanguage } = await import("../../dist/web/js/state.js");
const { buildContributionMonthLabels, latestHeatmapScrollLeft } = await import("../../dist/web/js/views/heatmap.js");

describe("shared heatmap", () => {
  it("does not overlap adjacent starting month labels", () => {
    const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const weeks = ["2025-06-29", "2025-07-06", "2025-07-13", "2025-08-03"].map((date) => [{ date }]);

    assert.deepEqual(buildContributionMonthLabels(weeks, 52, monthLabels), [
      { label: "Jul", week: 1 },
      { label: "Aug", week: 3 }
    ]);
  });

  it("counts the same non-ignored vocabulary activity for every heatmap", () => {
    const { counts } = buildHeatmapActivityCounts([
      { status: "known", addedAt: "2026-06-01T00:00:00.000Z", lastReviewedAt: "2026-06-20T00:00:00.000Z" },
      { status: "learning", addedAt: "2026-06-20T09:00:00.000Z" },
      { status: "ignored", lastReviewedAt: "2026-06-20T10:00:00.000Z" },
      { status: "known", lastReviewedAt: "not-a-date" }
    ]);

    assert.deepEqual(counts, { "2026-06-20": 2 });
  });

  it("keeps the earlier days a card was reviewed on", () => {
    // 20 cards reviewed on Monday and again on Friday keep only Friday's
    // lastReviewedAt; the per-day review counter keeps both days.
    const cards = Array.from({ length: 20 }, () => ({
      status: "learning", addedAt: "2026-06-01T09:00:00", lastReviewedAt: "2026-06-19T10:00:00"
    }));
    const { counts, firstTime } = buildHeatmapActivityCounts([
      ...cards,
      // Last reviewed before the counter's first day: that review still counts.
      { status: "known", addedAt: "2026-05-01T09:00:00", lastReviewedAt: "2026-06-10T10:00:00" },
      // Never reviewed: counts on the day it was added.
      { status: "learning", addedAt: "2026-06-19T08:00:00" }
    ], { "2026-06-15": 20, "2026-06-19": 20 });

    assert.deepEqual(counts, { "2026-06-10": 1, "2026-06-15": 20, "2026-06-19": 21 });
    assert.equal(firstTime, new Date("2026-06-10T10:00:00").getTime());
  });

  it("reads the review counter of the active language profile", () => {
    const defaults = createDefaultState();
    replaceState({
      ...defaults,
      profiles: {
        de: { ...defaults.profiles.de, reviewsByDay: { "2026-06-15": 4 } },
        fr: { vocab: {}, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [], reviewsByDay: { "2026-06-16": 2 } }
      }
    }, { save: false });

    assert.deepEqual(buildHeatmapActivityCounts([]).counts, { "2026-06-15": 4 });
    switchLearningLanguage("fr");
    assert.deepEqual(buildHeatmapActivityCounts([]).counts, { "2026-06-16": 2 });
    switchLearningLanguage("de");
    assert.deepEqual(buildHeatmapActivityCounts([]).counts, { "2026-06-15": 4 });
  });

  it("positions a clipped Pocket heatmap at the latest weeks", () => {
    assert.equal(latestHeatmapScrollLeft(920, 360), 560);
    assert.equal(latestHeatmapScrollLeft(320, 360), 0);
    const render = readFileSync(new URL("../../dist/web/js/render.js", import.meta.url), "utf8");
    const heatmap = readFileSync(new URL("../../dist/web/js/views/heatmap.js", import.meta.url), "utf8");
    const reviewChart = readFileSync(new URL("../../dist/web/js/vocabulary/review-chart.js", import.meta.url), "utf8");
    assert.match(render, /data-align-heatmap-latest/);
    assert.match(render, /viewName === lastRenderedView/);
    assert.match(heatmap, /delete alignmentHost\.dataset\.alignHeatmapLatest/);
    assert.match(reviewChart, /hEl\.parentElement !== reviewEls\.reviewChart/);
  });
});
