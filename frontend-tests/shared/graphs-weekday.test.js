import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// countReviewsByWeekday: review activity per weekday must come from
// lastReviewedAt only — cards never reviewed were counted by their
// addedAt day (583/640 in the user's data), faking "review activity".

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
    "../sm2.js": { todayISO: () => "2026-08-12", simulateNextReview: () => ({ interval: 1, nextDate: "2026-08-13" }) }
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

describe("countReviewsByWeekday (graphs/helpers)", () => {
  it("counts a review on its local weekday", async () => {
    const { countReviewsByWeekday } = await loadHelpers();
    const r = countReviewsByWeekday([
      { status: "learning", lastReviewedAt: "2026-08-10T09:00:00.000Z" } // Monday (2026-08-10)
    ]);
    assert.equal(r.total, 1);
    assert.equal(r.counts[1], 1); // Monday = index 1
  });

  it("excludes cards never reviewed (addedAt must not count)", async () => {
    const { countReviewsByWeekday } = await loadHelpers();
    const r = countReviewsByWeekday([
      { status: "new", addedAt: "2026-08-12T09:00:00.000Z" },
      { status: "learning", addedAt: "2026-08-12T09:00:00.000Z", lastReviewedAt: "2026-08-12T10:00:00.000Z" }
    ]);
    assert.equal(r.total, 1);
  });

  it("excludes ignored cards", async () => {
    const { countReviewsByWeekday } = await loadHelpers();
    const r = countReviewsByWeekday([
      { status: "ignored", lastReviewedAt: "2026-08-10T09:00:00.000Z" },
      { status: "learning", lastReviewedAt: "2026-08-11T09:00:00.000Z" }
    ]);
    assert.equal(r.total, 1);
    assert.equal(r.counts[2], 1); // Tuesday
  });
});
