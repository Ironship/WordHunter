// Statistics graphs view — orchestrator, re-exports from sub-modules.
import { state, saveState } from "../state.js";
import { t as rawT } from "../i18n.js";
import { updateColors, setGraphsLoading, renderHeatmap, renderStatsSummary } from "../graphs/helpers.js";
import type { ChartOptions, VocabEntry } from "../graphs/helpers.js";
import {
  renderDueForecast, renderStatusDonut, renderIntervalHistogram,
  renderEaseFactors, renderRepetitions, renderAddedOverTime,
  renderDayOfWeek, renderFsrsScatter, renderMatureVsYoung,
  renderVocabProgress
} from "../graphs/charts.js";
import type { ChartRenderer } from "../graphs/charts.js";

type TranslationVars = Record<string, string | number | boolean | null | undefined>;
type GraphContainer = { id: string; fn: ChartRenderer; wide?: boolean };

const t = rawT as (key: string, vars?: TranslationVars) => string;

const GRAPH_CONTAINERS: GraphContainer[] = [
  { id: "graph-vocab-progress", fn: renderVocabProgress, wide: true },
  { id: "graph-due", fn: renderDueForecast },
  { id: "graph-status", fn: renderStatusDonut },
  { id: "graph-intervals", fn: renderIntervalHistogram },
  { id: "graph-ease", fn: renderEaseFactors },
  { id: "graph-reps", fn: renderRepetitions },
  { id: "graph-added", fn: renderAddedOverTime },
  { id: "graph-dayofweek", fn: renderDayOfWeek },
  { id: "graph-mature", fn: renderMatureVsYoung },
  { id: "graph-fsrs", fn: renderFsrsScatter }
];

let graphRenderToken = 0;

function graphSignature(containers: readonly GraphContainer[]): string {
  return containers.map((c) => `${c.id}:${c.wide ? "wide" : "normal"}`).join("|");
}

function ensureGraphCanvases(el: HTMLElement, containers: readonly GraphContainer[]): boolean {
  const signature = graphSignature(containers);
  const hasAllCanvases = containers.every((c) => document.getElementById(c.id));
  if (el.dataset.graphSignature === signature && hasAllCanvases) return false;

  el.innerHTML = containers.map((c, index) => (
    `<div class="graph-cell${c.wide ? " graph-cell-wide" : ""}" style="--graph-index:${index}"><canvas id="${c.id}"></canvas></div>`
  )).join("");
  el.dataset.graphSignature = signature;
  delete el.dataset.graphRendered;
  return true;
}

function revealGraphCanvas(id: string, index: number): void {
  const graphCanvas = document.getElementById(id);
  if (!graphCanvas?.classList) return;
  graphCanvas.classList.remove("chart-reveal");
  graphCanvas.style?.setProperty?.("--chart-delay", `${Math.min(index, 5) * 45}ms`);
  void graphCanvas.offsetWidth;
  graphCanvas.classList.add("chart-reveal");
}

export function renderGraphs() {
  const renderToken = ++graphRenderToken;
  const _chartEntries = Object.values(state.vocab) as VocabEntry[];
  updateColors();
  const el = document.getElementById("graphs-canvas-area");
  if (!el) return;
  const graphArea: HTMLElement = el;
  const rangeSelect = document.getElementById("graphs-range") as HTMLSelectElement | null;
  const graphRange = state.preferences?.graphRange === "all" ? "all" : "recent";
  if (rangeSelect) {
    rangeSelect.value = graphRange;
    rangeSelect.onchange = () => {
      state.preferences.graphRange = rangeSelect.value === "all" ? "all" : "recent";
      saveState();
      renderGraphs();
    };
  }
  const graphOptions: ChartOptions = { allTime: graphRange === "all" };

  if (!Object.keys(state.vocab).length) {
    delete graphArea.dataset.graphSignature;
    delete graphArea.dataset.graphRendered;
    graphArea.innerHTML = `<div class="empty-state" style="padding:3rem"><p>${t("graphs.empty")}</p></div>`;
    const heat = document.getElementById("graphs-heatmap");
    if (heat) heat.innerHTML = "";
    setGraphsLoading(false);
    return;
  }

  ensureGraphCanvases(graphArea, GRAPH_CONTAINERS);
  setGraphsLoading(graphArea.dataset.graphRendered !== "1");

  let idx = 0;
  function renderBatch() {
    if (renderToken !== graphRenderToken) return;

    const end = Math.min(idx + 3, GRAPH_CONTAINERS.length);
    while (idx < end) {
      const c = GRAPH_CONTAINERS[idx++];
      if (document.getElementById(c.id)) {
        c.fn(_chartEntries, graphOptions);
        revealGraphCanvas(c.id, idx - 1);
      }
    }

    if (idx >= GRAPH_CONTAINERS.length) {
      renderHeatmap(_chartEntries, graphOptions);
      renderStatsSummary(_chartEntries);
      graphArea.dataset.graphRendered = "1";
      setGraphsLoading(false);
      return;
    }

    requestAnimationFrame(renderBatch);
  }

  requestAnimationFrame(renderBatch);
}
