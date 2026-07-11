import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildHeatmapActivityCounts } = await import("../../src/web/js/graphs/helpers.js");
const { buildContributionMonthLabels } = await import("../../src/web/js/views/heatmap.js");

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
});
