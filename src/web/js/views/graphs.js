// Statistics graphs view — orchestrator, re-exports from sub-modules.
import { state, saveState } from "../state.js";
import { t } from "../i18n.js";
import { updateColors, canvas, setGraphsLoading, renderHeatmap, renderStatsSummary } from "../graphs/helpers.js";
import {
  renderDueForecast, renderStatusDonut, renderIntervalHistogram,
  renderEaseFactors, renderRepetitions, renderAddedOverTime,
  renderDayOfWeek, renderFsrsScatter, renderMatureVsYoung,
  renderVocabProgress
} from "../graphs/charts.js";

export function renderGraphs() {
  const _chartEntries = Object.values(state.vocab);
  updateColors();
  const el = document.getElementById("graphs-canvas-area");
  if (!el) return;
  const rangeSelect = document.getElementById("graphs-range");
  const graphRange = state.preferences?.graphRange === "all" ? "all" : "recent";
  if (rangeSelect) {
    rangeSelect.value = graphRange;
    rangeSelect.onchange = () => {
      state.preferences.graphRange = rangeSelect.value === "all" ? "all" : "recent";
      saveState();
      renderGraphs();
    };
  }
  const graphOptions = { allTime: graphRange === "all" };

  if (!Object.keys(state.vocab).length) {
    el.innerHTML = `<div class="empty-state" style="padding:3rem"><p>${t("graphs.empty")}</p></div>`;
    const heat = document.getElementById("graphs-heatmap");
    if (heat) heat.innerHTML = "";
    setGraphsLoading(false);
    return;
  }

  const containers = [
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

  let html = "";
  for (const c of containers) html += `<div class="graph-cell${c.wide ? " graph-cell-wide" : ""}"><canvas id="${c.id}"></canvas></div>`;
  el.innerHTML = html;

  setGraphsLoading(true);

  let idx = 0;
  function renderNext() {
    if (idx >= containers.length) {
      renderHeatmap(_chartEntries, graphOptions);
      renderStatsSummary(_chartEntries);
      setGraphsLoading(false);
      return;
    }
    const c = containers[idx++];
    const ctx = canvas(c.id);
    if (ctx) c.fn(_chartEntries, graphOptions);
    requestAnimationFrame(renderNext);
  }
  requestAnimationFrame(renderNext);
}
