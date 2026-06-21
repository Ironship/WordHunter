/**
 * Shared helpers and module-level state for graphs.
 */
import { state } from "../state.js";
import { t } from "../i18n.js";
import { renderContributionHeatmap } from "../views/heatmap.js";

// Theme colors (initialized by updateColors)
export const C = { new: "#ff6b6b", learning: "#ffb84d", known: "#8ce99a", ignored: "#ced4da" };
export let text = "#1a201d", muted = "#6b726e", blue = "#6faae0", green = "#4fb38e", red = "#e37e76", amber = "#e6b361";
export let panelBg = "#fff", grid = "rgba(128,128,128,0.15)", labelMuted = "#8b98a0";

let tooltipEl = null;

const DAYS = 30;
export { DAYS };

export function updateColors() {
  const s = getComputedStyle(document.documentElement);
  text = s.getPropertyValue("--ink").trim() || "#1a201d";
  muted = s.getPropertyValue("--muted").trim() || "#6b726e";
  blue = s.getPropertyValue("--blue").trim() || "#6faae0";
  green = s.getPropertyValue("--green").trim() || "#4fb38e";
  red = s.getPropertyValue("--red").trim() || "#e37e76";
  amber = s.getPropertyValue("--amber").trim() || "#e6b361";
  panelBg = s.getPropertyValue("--panel").trim() || "#fff";
  grid = s.getPropertyValue("--line").trim() || "rgba(128,128,128,0.15)";
  labelMuted = text ? "rgba(" + hexToRgb(text) + ", 0.5)" : "#8b98a0";
  C.new = s.getPropertyValue("--token-new-bg") || "#ff6b6b";
  C.learning = s.getPropertyValue("--token-learning-bg") || "#ffb84d";
  C.known = s.getPropertyValue("--token-known-bg") || "#8ce99a";
  C.ignored = s.getPropertyValue("--token-ignored-bg") || "#ced4da";
}

function hexToRgb(hex) {
  if (hex.startsWith("#") && hex.length >= 7) {
    return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)].join(",");
  }
  return "0,0,0";
}

export function daysBetween(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

export function canvas(id) {
  const c = document.getElementById(id);
  if (!c) return null;
  const dpr = window.devicePixelRatio || 1;
  const p = c.parentElement;
  const ps = getComputedStyle(p);
  const w = Math.max(280, p.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight)) || 400;
  const h = parseInt(getComputedStyle(c).height) || Math.round(w / 1.5);
  c.width = w * dpr;
  c.height = h * dpr;
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.w = w; ctx.h = h;
  return ctx;
}

export function showTooltip(evt, tipText) {
  if (!tooltipEl) { tooltipEl = document.createElement("div"); tooltipEl.className = "chart-tooltip"; document.body.appendChild(tooltipEl); }
  tooltipEl.textContent = tipText;
  tooltipEl.style.left = (evt.pageX + 12) + "px";
  tooltipEl.style.top = (evt.pageY - 28) + "px";
  tooltipEl.style.display = "block";
}

export function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

export function drawBarChart(ctx, bins, maxVal, color, pad, { minimal = false } = {}) {
  const W = ctx.w, H = ctx.h;
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const barW = Math.max(3, pw / bins.length - (minimal ? 4 : (bins.length > 7 ? 4 : 6)));

  ctx.fillStyle = panelBg;
  ctx.fillRect(0, 0, W, H);
  if (!minimal) {
    ctx.strokeStyle = grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ph - (i / 4) * ph;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    }
    ctx.strokeRect(pad.left, pad.top, pw, ph);
    ctx.fillStyle = labelMuted;
    ctx.font = "10px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      ctx.fillText(Math.round((i / 4) * maxVal), pad.left - 6, pad.top + ph - (i / 4) * ph);
    }
  }
  for (let i = 0; i < bins.length; i++) {
    const h = (bins[i].val / maxVal) * ph;
    const x = pad.left + i * (pw / bins.length) + (minimal ? 2 : 3);
    ctx.fillStyle = bins[i].color || color;
    ctx.beginPath();
    ctx.roundRect(x, pad.top + ph - h, barW, Math.max(h, 0.5), [3, 3, 0, 0]);
    ctx.fill();
    ctx.fillStyle = minimal ? text : labelMuted;
    ctx.font = "9px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(bins[i].label, x + barW / 2, H - pad.bottom + (minimal ? 8 : 14));
    if (bins[i].val > 0) {
      ctx.fillStyle = text;
      ctx.font = minimal ? "9px Inter,sans-serif" : "bold 10px Inter, sans-serif";
      ctx.textBaseline = minimal ? "top" : "bottom";
      ctx.fillText(bins[i].val, x + barW / 2, minimal ? pad.top + ph - h - 4 : Math.max(18, pad.top + ph - h - 4));
    }
  }
}

export function setGraphsLoading(visible) {
  let overlay = document.getElementById("graphs-loading");
  if (visible) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "graphs-loading";
      overlay.className = "section-loading";
      overlay.innerHTML = `<div class="spinner" aria-hidden="true"></div><p class="muted-copy">${t("graphs.loading")}</p>`;
      const view = document.getElementById("graphs-view");
      if (view) view.appendChild(overlay);
    }
    overlay.hidden = false;
  } else if (overlay) {
    overlay.hidden = true;
  }
}

export function renderHeatmap(_chartEntries) {
  const el = document.getElementById("graphs-heatmap");
  if (!el) return;
  if (!Object.keys(state.vocab).length) { el.innerHTML = ""; return; }

  const counts = {};
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored") continue;
    const d = e.addedAt || e.lastReviewedAt;
    if (!d) continue;
    const day = new Date(d).toISOString().slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }

  renderContributionHeatmap(el, {
    getValue: (isoDate) => counts[isoDate],
    tooltip: (isoDate, count) => `${isoDate} · ${count} ${t("graphs.totalCards")}`
  });
}

export function renderStatsSummary(_chartEntries) {
  const el = document.getElementById("graphs-stats");
  if (!el) return;
  const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  let due = 0, overdue = 0, total = 0, newCount = 0, learning = 0, known = 0, matureCount = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored") continue;
    total++;
    if (e.status === "new") newCount++;
    else if (e.status === "learning") learning++;
    else if (e.status === "known") known++;
    if (e.status !== "known" && e.nextDate) {
      const d = daysBetween(e.nextDate, today);
      if (d < 0) overdue++;
      else if (d === 0) due++;
    }
    if (e.status !== "known" && (e.interval || 0) >= 21) matureCount++;
  }
  const dueTotal = due + overdue;
  const srsActive = total - known;
  el.innerHTML = `
    <div class="graphs-stats-row">
      <div class="graph-stat-box">
        <div class="graph-stat-value">${total}</div>
        <div class="graph-stat-label">${t("graphs.totalCards")}</div>
      </div>
      <div class="graph-stat-box highlight-red">
        <div class="graph-stat-value">${dueTotal}</div>
        <div class="graph-stat-label">${t("graphs.dueToday")}</div>
      </div>
      <div class="graph-stat-box highlight-green">
        <div class="graph-stat-value">${matureCount}</div>
        <div class="graph-stat-label">${t("graphs.mature")}</div>
      </div>
      <div class="graph-stat-box highlight-blue">
        <div class="graph-stat-value">${srsActive}</div>
        <div class="graph-stat-label">${t("graphs.active")}</div>
      </div>
    </div>`;
}
