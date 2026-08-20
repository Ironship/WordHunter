// Statistics graphs view — orchestrator, re-exports from sub-modules.
import { state, saveState, getVocabularyRevision } from "../state.js";
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
type GraphsViewportKey = string;

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
let graphsAiBound = false;

/**
 * Memo per range (perf): once the full chart batch completed for a given
 * range + vocabulary revision + viewport, re-entering the graphs view with an
 * unchanged key skips the expensive redraw+reveal of every canvas. Any vocab
 * mutation, range toggle or window resize invalidates it (fresh render).
 */
let lastGraphsRender: { range: "all" | "recent"; vocabRevision: number; viewport: GraphsViewportKey } | null = null;

function graphsViewportKey(): GraphsViewportKey {
  const width = typeof window !== "undefined" ? window.innerWidth : 0;
  const height = typeof window !== "undefined" ? window.innerHeight : 0;
  return `${width || 0}x${height || 0}`;
}

/**
 * "Explain with AI" button for the graphs view: visible only when the AI is
 * configured; streams a conclusions summary into the section below the
 * charts. Loaded dynamically so test harnesses that mock graphs.js do not
 * need an ai-explainer import map entry.
 */
function bindGraphsAiButton(): void {
  const button = document.getElementById("graphs-ai-explain") as HTMLButtonElement | null;
  // Some test harnesses mock `document` without querySelector.
  const output = typeof document.querySelector === "function"
    ? document.querySelector<HTMLElement>("[data-graphs-ai-explanation]")
    : null;
  if (!button || !output) return;
  if (graphsAiBound) return;
  graphsAiBound = true;
  void import("../ai-explainer.js").then(({ aiExplanationConfigured }) => {
    button.hidden = !aiExplanationConfigured();
    button.addEventListener("click", () => {
      void import("../graphs/ai-summary.js").then(({ runGraphsAiExplain }) => runGraphsAiExplain(button, output));
    });
  });
}

function graphSignature(containers: readonly GraphContainer[]): string {
  return containers.map((c) => `${c.id}:${c.wide ? "wide" : "normal"}`).join("|");
}

function ensureGraphCanvases(el: HTMLElement, containers: readonly GraphContainer[]): boolean {
  const signature = graphSignature(containers);
  const hasAllCanvases = containers.every((c) => document.getElementById(c.id));
  if (el.dataset.graphSignature === signature && hasAllCanvases) return false;

  // Cell order is fixed (GRAPH_CONTAINERS), so the card/reveal stagger
  // `--graph-index` / `--chart-delay` is declared in CSS via nth-child
  // instead of an inline style.
  el.innerHTML = containers.map((c) => (
    `<div class="graph-cell${c.wide ? " graph-cell-wide" : ""}"><canvas id="${c.id}"></canvas></div>`
  )).join("");
  el.dataset.graphSignature = signature;
  delete el.dataset.graphRendered;
  return true;
}

function revealGraphCanvas(id: string): void {
  const graphCanvas = document.getElementById(id);
  if (!graphCanvas?.classList) return;
  graphCanvas.classList.remove("chart-reveal");
  void graphCanvas.offsetWidth;
  graphCanvas.classList.add("chart-reveal");
}

export function renderGraphs() {
  const renderToken = ++graphRenderToken;
  bindGraphsAiButton();
  const _chartEntries = Object.values(state.vocab) as VocabEntry[];
  updateColors();
  const el = document.getElementById("graphs-canvas-area");
  if (!el) return;
  const graphArea: HTMLElement = el;
  const rangeSelect = document.getElementById("graphs-range") as HTMLSelectElement | null;
  const graphRange: "all" | "recent" = state.preferences?.graphRange === "all" ? "all" : "recent";
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
    lastGraphsRender = null;
    graphArea.innerHTML = `<div class="empty-state p-3"><p>${t("graphs.empty")}</p><button type="button" class="secondary-button" data-open-view="library">${t("nav.library")}</button></div>`;
    const heat = document.getElementById("graphs-heatmap");
    if (heat) heat.innerHTML = "";
    setGraphsLoading(false);
    return;
  }

  const memoKey = {
    range: graphRange,
    vocabRevision: getVocabularyRevision(),
    viewport: graphsViewportKey()
  };

  // Same range + unchanged vocabulary + same viewport: the charts on these
  // canvases are already correct — skip redraw + reveal entirely.
  if (lastGraphsRender
    && lastGraphsRender.range === memoKey.range
    && lastGraphsRender.vocabRevision === memoKey.vocabRevision
    && lastGraphsRender.viewport === memoKey.viewport
    && GRAPH_CONTAINERS.every((c) => document.getElementById(c.id))) {
    graphArea.dataset.graphRendered = "1";
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
        revealGraphCanvas(c.id);
      }
    }

    if (idx >= GRAPH_CONTAINERS.length) {
      renderHeatmap(_chartEntries, graphOptions);
      renderStatsSummary(_chartEntries);
      graphArea.dataset.graphRendered = "1";
      // Commit the memo only after the full batch actually completed, so a
      // mid-batch navigation never leaves a stale-but-flagged render behind.
      lastGraphsRender = memoKey;
      setGraphsLoading(false);
      return;
    }

    requestAnimationFrame(renderBatch);
  }

  requestAnimationFrame(renderBatch);
}
