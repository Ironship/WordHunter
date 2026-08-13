import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// collectFsrsPoints: fsrs cards with positive stability form the scatter,
// KNOWN cards included (they carry the top stability values — the axis must
// span them).

async function loadHelpers() {
  const globals = {
    console, Date, Math, JSON, setTimeout, clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: { getElementById: () => null, querySelectorAll: () => [] },
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

describe("collectFsrsPoints (graphs/helpers)", () => {
  it("includes a KNOWN fsrs card and spans the axis to its stability", async () => {
    const { collectFsrsPoints } = await loadHelpers();
    const r = collectFsrsPoints([
      { status: "known", srsAlgorithm: "fsrs", stability: 33.14, difficulty: 5 }
    ]);
    assert.equal(r.points.length, 1);
    assert.equal(r.maxS, 33.14);
  });

  it("excludes sm2 cards", async () => {
    const { collectFsrsPoints } = await loadHelpers();
    const r = collectFsrsPoints([
      { status: "learning", srsAlgorithm: "sm2", stability: 4, difficulty: 5 }
    ]);
    assert.equal(r.points.length, 0);
    assert.equal(r.maxS, 0);
  });

  it("excludes ignored and stability-0 cards", async () => {
    const { collectFsrsPoints } = await loadHelpers();
    const r = collectFsrsPoints([
      { status: "ignored", srsAlgorithm: "fsrs", stability: 9, difficulty: 5 },
      { status: "learning", srsAlgorithm: "fsrs", stability: 0, difficulty: 5 },
      { status: "learning", srsAlgorithm: "fsrs", stability: 2.5, difficulty: 6 }
    ]);
    assert.equal(r.points.length, 1);
    assert.equal(r.maxS, 2.5);
  });
});
