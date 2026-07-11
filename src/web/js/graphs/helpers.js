/**
 * Shared helpers and module-level state for graphs.
 */
import { state } from "../state.js";
import { t } from "../i18n.js";
import { setElementBusy } from "../loading.js";
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
  const h = Math.round(parseFloat(getComputedStyle(c).height)) || Math.round(w / 1.5);
  const pixelWidth = Math.max(1, Math.round(w * dpr));
  const pixelHeight = Math.max(1, Math.round(h * dpr));
  if (c.width !== pixelWidth || c.height !== pixelHeight) {
    c.width = pixelWidth;
    c.height = pixelHeight;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.w = w; ctx.h = h;
  return ctx;
}

export function showTooltip(evt, tipText) {
  if (!tooltipEl) { tooltipEl = document.createElement("div"); tooltipEl.className = "chart-tooltip"; document.body.appendChild(tooltipEl); }
  tooltipEl.textContent = tipText;
  tooltipEl.style.left = (evt.clientX + 14) + "px";
  tooltipEl.style.top = (evt.clientY - 32) + "px";
  tooltipEl.style.display = "block";
}

export function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

function colorWithAlpha(color, alpha) {
  const value = String(color || "").trim();
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return `rgba(${channels.join(",")},${alpha})`;
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  return rgb ? `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})` : value;
}

export function drawChartBar(ctx, x, y, width, height, color, radius = 3) {
  const visibleHeight = Math.max(height, 0.5);
  const top = y + height - visibleHeight;
  let fill = color;
  if (typeof ctx.createLinearGradient === "function") {
    const gradient = ctx.createLinearGradient(0, top, 0, top + visibleHeight);
    gradient.addColorStop(0, colorWithAlpha(color, 0.98));
    gradient.addColorStop(1, colorWithAlpha(color, 0.58));
    fill = gradient;
  }
  ctx.save?.();
  ctx.shadowColor = colorWithAlpha(color, 0.2);
  ctx.shadowBlur = 7;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, top, width, visibleHeight, [radius, radius, 1, 1]);
  ctx.fill();
  ctx.restore?.();
}

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
    drawChartBar(ctx, x, pad.top + ph - h, barW, h, bins[i].color || color);
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
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "polite");
      const view = document.getElementById("graphs-view");
      if (view) view.appendChild(overlay);
    }
    overlay.hidden = false;
  } else if (overlay) {
    overlay.hidden = true;
  }
  setElementBusy(document.getElementById("graphs-view"), visible);
}

export function activityDateForHeatmap(entry) {
  return entry?.lastReviewedAt || entry?.addedAt || "";
}

export function buildHeatmapActivityCounts(entries) {
  const counts = {};
  let firstTime = Infinity;
  for (const e of entries || []) {
    if (e.status === "ignored") continue;
    const d = activityDateForHeatmap(e);
    if (!d) continue;
    const time = new Date(d).getTime();
    if (!Number.isFinite(time)) continue;
    firstTime = Math.min(firstTime, time);
    const day = new Date(time).toISOString().slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }
  return { counts, firstTime };
}

export function renderHeatmap(_chartEntries, options = {}) {
  const el = document.getElementById("graphs-heatmap");
  if (!el) return;
  if (!Object.keys(state.vocab).length) { el.innerHTML = ""; return; }

  const { counts, firstTime } = buildHeatmapActivityCounts(_chartEntries || Object.values(state.vocab));
  const weeksToShow = options.allTime && Number.isFinite(firstTime)
    ? Math.max(52, Math.ceil((Date.now() - firstTime) / (7 * 86400000)) + 1)
    : 52;

  renderContributionHeatmap(el, {
    weeksToShow,
    getValue: (isoDate) => counts[isoDate],
    tooltip: (isoDate, count) => `${isoDate} · ${count} ${t("graphs.totalCards")}`
  });
}

export function renderStatsSummary(_chartEntries) {
  const el = document.getElementById("graphs-stats");
  if (!el) return;
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
