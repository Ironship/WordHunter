import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// countMatureYoung: mature = interval >= 21 days (Anki convention).
// Ignored cards are suspended and excluded. KNOWN cards count — after the
// PR #243 graduation fix they reach "known" at the 21-day threshold and
// are the classic mature cards; excluding them made the mature/young chart
// permanently one-sided ("everything in young").

function source(path) {
  return readFile(path, "utf8");
}

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
    "../views/heatmap.js": { renderContributionHeatmap: () => {} }
  };
  for (const [specifier, values] of Object.entries(imports)) {
    modules.set(specifier, createMock(specifier, values));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(await source("dist/web/js/graphs/helpers.js"), {
    context,
    identifier: "helpers.js"
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

describe("countMatureYoung (graphs/helpers)", () => {
  it("counts a known card with a 30-day interval as mature", async () => {
    const { countMatureYoung } = await loadHelpers();
    const r1 = countMatureYoung([{ status: "known", interval: 30 }]);
    assert.equal(r1.young, 0);
    assert.equal(r1.mature, 1);
  });

  it("counts a learning card below 21 days as young", async () => {
    const { countMatureYoung } = await loadHelpers();
    const r2 = countMatureYoung([
      { status: "learning", interval: 3 },
      { status: "learning", interval: 20 }
    ]);
    assert.equal(r2.young, 2);
    assert.equal(r2.mature, 0);
  });

  it("excludes ignored cards (suspended), regardless of interval", async () => {
    const { countMatureYoung } = await loadHelpers();
    const r3 = countMatureYoung([
      { status: "ignored", interval: 40 },
      { status: "learning", interval: 5 }
    ]);
    assert.equal(r3.young, 1);
    assert.equal(r3.mature, 0);
  });

  it("treats a missing interval as young (new cards)", async () => {
    const { countMatureYoung } = await loadHelpers();
    const r4 = countMatureYoung([{ status: "new" }, { status: "known", interval: 21 }]);
    assert.equal(r4.young, 1);
    assert.equal(r4.mature, 1);
  });
});
