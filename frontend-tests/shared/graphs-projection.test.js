import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// projectDueBuckets: real nextDate buckets + one simulated "good" review for
// every due card (the Graphs forecast projection). The scheduler is mocked
// to nextDate = today + 1 so the bucket math is what's under test.

async function loadHelpers() {
  const globals = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => []
    },
    window: {}
  };
  const context = vm.createContext(globals);
  const modules = new Map();
  const createMock = (specifier, values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context, identifier: `mock:${specifier}` }
    );
  const imports = {
    "../state.js": { state: { vocab: {} } },
    "../i18n.js": { t: (key) => key },
    "../loading.js": { setElementBusy: () => {} },
    "../views/heatmap.js": { renderContributionHeatmap: () => {} },
    "../sm2.js": {
      todayISO: () => "2026-08-12",
      simulateNextReview: () => ({ interval: 1, nextDate: "2026-08-13" })
    }
  };
  for (const [specifier, values] of Object.entries(imports)) {
    modules.set(specifier, createMock(specifier, values));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(await readFile("dist/web/js/graphs/helpers.js", "utf8"), {
    context,
    identifier: "helpers.js"
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

const TODAY = "2026-08-12";

describe("projectDueBuckets (graphs/helpers)", () => {
  it("keeps a due-today card in bucket 0 and projects its next review", async () => {
    const { projectDueBuckets } = await loadHelpers();
    const r = projectDueBuckets(
      [{ status: "learning", nextDate: "2026-08-12" }],
      TODAY,
      30,
      4
    );
    assert.equal(r.total, 1);
    assert.equal(r.overdue, 0);
    assert.equal(r.buckets[0], 1);
    assert.equal(r.buckets[1], 1); // simulated +1 day
  });

  it("keeps a future card in its bucket without projecting", async () => {
    const { projectDueBuckets } = await loadHelpers();
    const r = projectDueBuckets(
      [{ status: "learning", nextDate: "2026-08-17" }],
      TODAY,
      30,
      4
    );
    assert.equal(r.total, 1);
    assert.equal(r.buckets[5], 1);
    assert.equal(r.buckets[1], 0);
  });

  it("counts an overdue card in the overdue bar and projects it", async () => {
    const { projectDueBuckets } = await loadHelpers();
    const r = projectDueBuckets(
      [{ status: "learning", nextDate: "2026-08-09" }],
      TODAY,
      30,
      4
    );
    assert.equal(r.overdue, 1);
    assert.equal(r.buckets[1], 1);
  });

  it("skips known, ignored and missing-nextDate cards", async () => {
    const { projectDueBuckets } = await loadHelpers();
    const r = projectDueBuckets(
      [
        { status: "known", nextDate: "2026-08-12" },
        { status: "ignored", nextDate: "2026-08-12" },
        { status: "learning" }
      ],
      TODAY,
      30,
      4
    );
    assert.equal(r.total, 0);
    assert.equal(r.buckets.every((v) => v === 0), true);
  });
});
