import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// clampTooltipPosition: keeps the chart tooltip inside the viewport with an
// 8 px margin. Readability fix — near the right/bottom edges the tooltip
// used to render off-screen.

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
    "../sm2.js": { todayISO: () => "2026-08-12" }
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

describe("clampTooltipPosition (graphs/helpers)", () => {
  it("keeps a tooltip near the top-left corner as-is", async () => {
    const { clampTooltipPosition } = await loadHelpers();
    const r = clampTooltipPosition(100, 60, 120, 40, 1280, 720);
    assert.equal(r.x, 100);
    assert.equal(r.y, 60);
  });

  it("clamps a tooltip that would overflow the right edge", async () => {
    const { clampTooltipPosition } = await loadHelpers();
    const r = clampTooltipPosition(1200, 300, 200, 40, 1280, 720);
    assert.equal(r.x, 1280 - 200 - 8);
    assert.equal(r.y, 300);
  });

  it("clamps a tooltip that would overflow the bottom edge", async () => {
    const { clampTooltipPosition } = await loadHelpers();
    const r = clampTooltipPosition(500, 700, 160, 60, 1280, 720);
    assert.equal(r.x, 500);
    assert.equal(r.y, 720 - 60 - 8);
  });

  it("clamps negative coordinates to the 8 px margin", async () => {
    const { clampTooltipPosition } = await loadHelpers();
    const r = clampTooltipPosition(-50, -20, 120, 40, 1280, 720);
    assert.equal(r.x, 8);
    assert.equal(r.y, 8);
  });
});
