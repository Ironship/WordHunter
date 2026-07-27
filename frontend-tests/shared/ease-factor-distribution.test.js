import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildEaseFactorBins } = await import("../../dist/web/js/graphs/helpers.js");

describe("ease factor distribution", () => {
  it("uses all six contiguous SM-2 bins and excludes non-SM-2 review cards", () => {
    const labels = ["1.4-1.6", "1.7-2.0", "2.1-2.5", "2.6-3.0", ">3.0"];
    const entries = [
      { status: "learning", srsAlgorithm: "sm2", efactor: 1.3 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 1.3001 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 1.6 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 1.6001 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 2.0 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 2.0001 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 2.5 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 2.5001 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 3.0 },
      { status: "learning", srsAlgorithm: "sm2", efactor: 3.0001 },
      { status: "new", srsAlgorithm: "sm2" },
      { status: "learning", srsAlgorithm: "sm2", efactor: 0 },
      { status: "learning", srsAlgorithm: "fsrs", efactor: 2.5 },
      { status: "known", srsAlgorithm: "sm2", efactor: 2.5 },
      { status: "ignored", srsAlgorithm: "sm2", efactor: 2.5 }
    ];

    const bins = buildEaseFactorBins(entries, labels, "Leeches");

    assert.deepEqual(bins.map(({ label, val }) => ({ label, val })), [
      { label: "Leeches", val: 2 },
      { label: "1.4-1.6", val: 2 },
      { label: "1.7-2.0", val: 2 },
      { label: "2.1-2.5", val: 3 },
      { label: "2.6-3.0", val: 2 },
      { label: ">3.0", val: 1 }
    ]);
  });
});
