// Statistics graphs view — canvas charts inspired by Anki.
import { state } from "../state.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";

let _chartEntries = null;

const DAYS = 30;
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ── Theme colors ──
const C = { new: "#ff6b6b", learning: "#ffb84d", known: "#8ce99a", ignored: "#ced4da" };
let text = "#1a201d", muted = "#6b726e", blue = "#6faae0", green = "#4fb38e", red = "#e37e76", amber = "#e6b361";
let panelBg = "#fff", grid = "rgba(128,128,128,0.15)", labelMuted = "#8b98a0";
let tooltipEl = null;

function updateColors() {
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

// ── Canvas helper ──
function canvas(id) {
  const c = document.getElementById(id);
  if (!c) return null;
  const dpr = window.devicePixelRatio || 1;
  const p = c.parentElement;
  const ps = getComputedStyle(p);
  const w = Math.max(280, p.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight)) || 400;
  const h = 260;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = w + "px";
  c.style.height = h + "px";
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.w = w; ctx.h = h;
  return ctx;
}

function daysBetween(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

// ── Tooltip on bar charts ──
function showTooltip(evt, text) {
  if (!tooltipEl) { tooltipEl = document.createElement("div"); tooltipEl.className = "chart-tooltip"; document.body.appendChild(tooltipEl); }
  tooltipEl.textContent = text;
  tooltipEl.style.left = (evt.pageX + 12) + "px";
  tooltipEl.style.top = (evt.pageY - 28) + "px";
  tooltipEl.style.display = "block";
}
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

// ── Shared bar chart builder ──
function drawBarChart(ctx, bins, maxVal, color, pad) {
  const W = ctx.w, H = ctx.h;
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const barW = Math.max(3, pw / bins.length - (bins.length > 7 ? 4 : 6));

  ctx.fillStyle = panelBg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = grid;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }
  // Chart border
  ctx.strokeRect(pad.left, pad.top, pw, ph);
  ctx.fillStyle = labelMuted;
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    ctx.fillText(Math.round((i / 4) * maxVal), pad.left - 6, pad.top + ph - (i / 4) * ph);
  }
  for (let i = 0; i < bins.length; i++) {
    const h = (bins[i].val / maxVal) * ph;
    const x = pad.left + i * (pw / bins.length) + 3;
    ctx.fillStyle = bins[i].color || color;
    ctx.beginPath();
    ctx.roundRect(x, pad.top + ph - h, barW, Math.max(h, 0.5), [3, 3, 0, 0]);
    ctx.fill();
    ctx.fillStyle = labelMuted;
    ctx.font = "9px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(bins[i].label, x + barW / 2, H - pad.bottom + 14);
    if (bins[i].val > 0) {
      ctx.fillStyle = text;
      ctx.font = "bold 10px Inter, sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText(bins[i].val, x + barW / 2, Math.max(18, pad.top + ph - h - 4));
    }
  }
}

// ── 1. Due forecast ──
function renderDueForecast(ctx) {
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const pad = { top: 52, right: 20, bottom: 40, left: 44 };
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  const today = new Date().toISOString().slice(0, 10);
  const buckets = new Array(DAYS).fill(0);
  let overdue = 0, total = 0;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known") continue;
    if (!e.nextDate) continue;
    total++;
    const delta = daysBetween(e.nextDate, today);
    if (delta < 0) overdue++;
    else if (delta < DAYS) buckets[delta]++;
  }
  const maxVal = Math.max(1, overdue, ...buckets);
  const totalSlots = DAYS + (overdue > 0 ? 1 : 0);
  const barW = Math.max(2, pw / totalSlots - 3);

  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = grid; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }

  // Chart border
  ctx.strokeRect(pad.left, pad.top, pw, ph);

  const hotAreas = [];
  let bx = pad.left + 1;
  if (overdue > 0) {
    const oh = (overdue / maxVal) * ph;
    ctx.fillStyle = red;
    ctx.beginPath(); ctx.roundRect(bx, pad.top + ph - oh, barW, oh, [2, 2, 0, 0]); ctx.fill();
    hotAreas.push({ x: bx, y: pad.top + ph - oh, w: barW, h: oh, label: overdue + ' ' + t("graphs.cards") });
    bx += barW + 3;
  }
  const dayStart = bx;
  for (let d = 0; d < DAYS; d++) {
    const h = (buckets[d] / maxVal) * ph;
    const x = bx + d * (barW + 3);
    const y = pad.top + ph - h;
    ctx.fillStyle = d === 0 ? green : blue;
    ctx.beginPath(); ctx.roundRect(x, y, barW, h, [2, 2, 0, 0]); ctx.fill();
    hotAreas.push({ x, y, w: barW, h, label: buckets[d] + ' ' + t("graphs.cards") });
  }

  // Y-axis labels drawn after bars so they're not covered
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) ctx.fillText(Math.round((i / 4) * maxVal), pad.left - 6, pad.top + ph - (i / 4) * ph);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let d = 0; d < DAYS; d += 5) {
    const x = dayStart + d * (barW + 3) + barW / 2;
    ctx.fillText(d === 0 ? t("graphs.today") : `+${d}`, x, H - pad.bottom + 16);
  }
  // Stats below
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.dueForecast"), W / 2, 10);
  ctx.fillStyle = labelMuted; ctx.font = "11px Inter, sans-serif";
  ctx.fillText(t("graphs.totalReviews", { n: total, overdue }), W / 2, 24);

  // Tooltip binding
  const canv = document.getElementById("graph-due");
  if (canv) {
    canv.onmousemove = (e) => {
      const r = canv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      for (const a of hotAreas) {
        if (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h) {
          showTooltip(e, a.label); return;
        }
      }
      hideTooltip();
    };
    canv.onmouseleave = hideTooltip;
  }
}

// ── 2. Status donut (clickable) ──
function renderStatusDonut(ctx) {
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const cx = W / 2, cy = H / 2 + 6;
  const r = Math.min(W, H) / 2 - 36, ir = r * 0.58;
  const counts = { new: 0, learning: 0, known: 0, ignored: 0 };
  for (const e of _chartEntries || Object.values(state.vocab)) if (counts[e.status] !== undefined) counts[e.status]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const slices = [
    { status: "new", label: t("vocab.statusNew"), val: counts.new, color: C.new },
    { status: "learning", label: t("vocab.statusLearning"), val: counts.learning, color: C.learning },
    { status: "known", label: t("vocab.statusKnown"), val: counts.known, color: C.known },
    { status: "ignored", label: t("vocab.statusIgnored"), val: counts.ignored, color: C.ignored }
  ].filter(s => s.val > 0);

  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  let angle = -Math.PI / 2;
  const arcData = [];
  for (const s of slices) {
    const slice = (s.val / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.arc(cx, cy, ir, angle + slice, angle, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    arcData.push({ ...s, start: angle, end: angle + slice, r, ir, cx, cy });
    angle += slice;
  }
  // Center text
  ctx.fillStyle = text; ctx.font = "700 22px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(total, cx, cy - 4);
  ctx.fillStyle = labelMuted; ctx.font = "11px Inter, sans-serif";
  ctx.fillText(t("graphs.totalCards"), cx, cy + 16);
  // Legend
  let lx = 12, ly = H - 16;
  ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "left";
  for (const s of slices) {
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.roundRect(lx, ly - 5, 10, 10, 2); ctx.fill();
    ctx.fillStyle = text; ctx.fillText(`${s.label}: ${s.val}`, lx + 14, ly);
    lx += ctx.measureText(`${s.label}: ${s.val}`).width + 28;
    if (lx > W - 60) { lx = 12; ly -= 20; }
  }
  ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(t("graphs.statusDistribution"), W / 2, 6);

  // Click handler
  const canv = document.getElementById("graph-status");
  if (canv) {
    canv.style.cursor = "pointer";
    canv.onclick = (e) => {
      const r = canv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= ir && dist <= r) {
        let a = Math.atan2(dy, dx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        for (const s of slices) {
          const sa = s.start < -Math.PI / 2 ? s.start + Math.PI * 2 : s.start;
          const ea = s.end < -Math.PI / 2 ? s.end + Math.PI * 2 : s.end;
          if (a >= sa && a <= ea) {
            import("../render.js").then(m => { state.filters.vocabStatus = s.status; m.setView("vocabulary"); });
            return;
          }
        }
      }
    };
  }
}

// ── 3. Review intervals ──
function renderIntervalHistogram(ctx) {
  if (!ctx) return;
  const binLabels = t("graphs.binIntervalLabels").split("|");
  const bins = binLabels.map(label => ({ label, val: 0 }));
  const limits = [-Infinity, 0, 3, 7, 14, 30, 90, Infinity];
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || !e.interval && e.interval !== 0) continue;
    for (let i = 0; i < bins.length; i++) if ((e.interval||0) >= limits[i] && (e.interval||0) <= limits[i+1]) { bins[i].val++; break; }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  bins.forEach(b => { b.color = blue; });
  drawBarChart(ctx, bins, maxVal, blue, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.intervals"), ctx.w / 2, 10);
}

// ── 4. Ease factors ──
function renderEaseFactors(ctx) {
  if (!ctx) return;
  const easeLabels = t("graphs.binEaseLabels").split("|");
  const _easeColors = [red, blue, blue, blue, blue, green];
  const bins = easeLabels.map((label, i) => ({
    label: i === 0 ? t("graphs.leeches") : label,
    val: 0,
    color: _easeColors[i],
    range: [
      [1.3, 1.3], [1.31, 1.6], [1.61, 2.0], [2.01, 2.5], [2.51, 3.0], [3.01, Infinity]
    ][i]
  }));
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored") continue;
    const ef = e.efactor || 2.5;
    for (const b of bins) { if (ef >= b.range[0] && ef <= b.range[1]) { b.val++; break; } }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  drawBarChart(ctx, bins, maxVal, blue, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.easeDistribution"), ctx.w / 2, 10);
}

// ── 5. Repetitions ──
function renderRepetitions(ctx) {
  if (!ctx) return;
  const repLabels = t("graphs.binRepsLabels").split("|");
  const bins = repLabels.map(label => ({ label, val: 0 }));
  const limits = [-Infinity, 0, 1, 3, 7, 15, Infinity];
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored") continue;
    for (let i = 0; i < bins.length; i++) if ((e.repetition||0) >= limits[i] && (e.repetition||0) <= limits[i+1]) { bins[i].val++; break; }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  bins.forEach(b => { b.color = green; });
  drawBarChart(ctx, bins, maxVal, green, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.repetitions"), ctx.w / 2, 10);
}

// ── 6. Cards added (12 months) ──
function renderAddedOverTime(ctx) {
  if (!ctx) return;
  const now = new Date();
  const bins = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    bins.push({ label: d.toLocaleDateString(undefined, { month: "short" }), val: 0, color: amber });
  }
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (!e.addedAt) continue;
    const d = new Date(e.addedAt);
    const idx = 11 - (now.getFullYear() * 12 + now.getMonth() - d.getFullYear() * 12 - d.getMonth());
    if (idx >= 0 && idx < 12) bins[idx].val++;
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 50, right: 14, left: 44, bottom: 38 };
  drawBarChart(ctx, bins, maxVal, amber, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.addedOverTime"), ctx.w / 2, 10);
}

// ── 7. Day-of-week heatmap ──
function renderDayOfWeek(ctx) {
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const dayNames = DAY_KEYS.map((key) => t(`graphs.${key}`));
  const counts = new Array(7).fill(0);
  let total = 0;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (!e.addedAt && !e.lastReviewedAt) continue;
    const d = new Date(e.lastReviewedAt || e.addedAt);
    counts[d.getDay()]++; total++;
  }
  const maxVal = Math.max(1, ...counts);
  const pad = { top: 48, right: 28, bottom: 54, left: 50 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const barW = Math.max(6, pw / 7 - 6);

  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = grid; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }
  ctx.strokeRect(pad.left, pad.top, pw, ph);
  for (let i = 0; i < 7; i++) {
    const h = (counts[i] / maxVal) * ph;
    const x = pad.left + i * (pw / 7) + 3;
    ctx.fillStyle = `hsl(${210 + i * 15}, 70%, ${40 + (counts[i] / maxVal) * 25}%)`;
    ctx.beginPath();
    ctx.roundRect(x, pad.top + ph - h, barW, Math.max(h, 0.5), [3, 3, 0, 0]);
    ctx.fill();
    // Value at top of bar (consistent with bar charts)
    if (counts[i] > 0) {
      ctx.fillStyle = text; ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(counts[i], x + barW / 2, Math.max(16, pad.top + ph - h - 4));
    }
    // Day name as X-axis label at bottom
    ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(dayNames[i], x + barW / 2, H - pad.bottom + 8);
  }
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.dayOfWeek"), W / 2, 10);
  ctx.textBaseline = "middle";
}

// ── 8. FSRS scatter ──
function renderFsrsScatter(ctx) {
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const pad = { top: 30, right: 20, bottom: 40, left: 48 };
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  const points = [];
  let maxS = 0, maxD = 10;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.srsAlgorithm !== "fsrs") continue;
    const s = e.stability || 0, d = e.difficulty || 5;
    if (s > 0) { points.push({ s, d }); if (s > maxS) maxS = s; }
  }
  if (!points.length) {
    ctx.fillStyle = text; ctx.font = "13px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(t("graphs.noFsrsData"), W / 2, H / 2);
    return;
  }
  maxS = Math.max(maxS, 1);
  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = grid; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    const x = pad.left + (i / 4) * pw;
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
  }
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const fmt = (v) => maxS < 10 ? v.toFixed(1) : Math.round(v).toString();
  for (let i = 0; i <= 4; i++) { ctx.fillText(fmt((i / 4) * maxS), pad.left - 6, pad.top + ph - (i / 4) * ph); }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) ctx.fillText(Math.round((i / 4) * maxD).toString(), pad.left + (i / 4) * pw, H - pad.bottom + 14);
  // Points
  for (const p of points) {
    const x = pad.left + (p.d / maxD) * pw;
    const y = pad.top + ph - (p.s / maxS) * ph;
    ctx.fillStyle = blue; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.fsrsTitle"), W / 2, 10);
}

// ── 9. Mature vs Young ──
function renderMatureVsYoung(ctx) {
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const cx = W / 2, cy = H / 2 + 4;
  const r = Math.min(W, H) / 2 - 34, ir = r * 0.55;
  let young = 0, mature = 0;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored") continue;
    if ((e.interval || 0) >= 21) mature++; else young++;
  }
  const total = Math.max(1, young + mature);

  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  const youngAngle = (young / total) * Math.PI * 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + youngAngle); ctx.arc(cx, cy, ir, -Math.PI / 2 + youngAngle, -Math.PI / 2, true); ctx.closePath();
  ctx.fillStyle = amber; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2 + youngAngle, -Math.PI / 2 + Math.PI * 2); ctx.arc(cx, cy, ir, -Math.PI / 2 + Math.PI * 2, -Math.PI / 2 + youngAngle, true); ctx.closePath();
  ctx.fillStyle = green; ctx.fill();

  ctx.fillStyle = text; ctx.font = "700 20px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(total, cx, cy - 6);
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif";
  ctx.fillText(t("graphs.totalCards"), cx, cy + 14);

  // Legend — dynamic layout matching status donut
  let lx = 12, ly = H - 16;
  ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const legendItems = [
    { label: t("graphs.young"), val: young, color: amber },
    { label: t("graphs.mature"), val: mature, color: green }
  ].filter(s => s.val > 0 || total > 0);
  for (const s of legendItems) {
    const txt = `${s.label}: ${s.val}`;
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.roundRect(lx, ly - 5, 10, 10, 2); ctx.fill();
    ctx.fillStyle = text; ctx.fillText(txt, lx + 14, ly);
    lx += ctx.measureText(txt).width + 28;
    if (lx > W - 60) { lx = 12; ly -= 20; }
  }

  ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center";
  ctx.fillText(t("graphs.matureVsYoung"), W / 2, 4);
}

// ── Stats summary ──
function renderStatsSummary() {
  const el = document.getElementById("graphs-stats");
  if (!el) return;
  let due = 0, overdue = 0, total = 0, newCount = 0, learning = 0, known = 0, matureCount = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const e of _chartEntries || Object.values(state.vocab)) {
    total++;
    if (e.status === "new") newCount++;
    else if (e.status === "learning") learning++;
    else if (e.status === "known") known++;
    if (e.status !== "ignored" && e.status !== "known" && e.nextDate) {
      const d = daysBetween(e.nextDate, today);
      if (d < 0) overdue++;
      else if (d === 0) due++;
    }
    if ((e.interval || 0) >= 21) matureCount++;
  }
  const dueTotal = due + overdue;
  const srsActive = total - known - (_chartEntries || Object.values(state.vocab)).filter(v => v.status === "ignored").length;
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

// ── GitHub-style contribution heatmap ──
function renderHeatmap() {
  const el = document.getElementById("graphs-heatmap");
  if (!el) return;
  if (!Object.keys(state.vocab).length) { el.innerHTML = ""; return; }

  const now = new Date();
  // 52 weeks back, aligned to Sunday
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - startDate.getDay() - 51 * 7); // back to Sun, then 51 more weeks

  // Count per day
  const counts = {};
  for (const e of _chartEntries || Object.values(state.vocab)) {
    const d = e.addedAt || e.lastReviewedAt;
    if (!d) continue;
    const day = new Date(d).toISOString().slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  }

  const maxCount = Math.max(1, ...Object.values(counts));
  const levels = [0, Math.max(1, Math.ceil(maxCount * 0.25)), Math.max(2, Math.ceil(maxCount * 0.5)), Math.max(3, Math.ceil(maxCount * 0.75))];

  function color(count) {
    const s = getComputedStyle(document.documentElement);
    const grn = s.getPropertyValue("--green").trim() || "#4fb38e";
    if (count === 0) return s.getPropertyValue("--panel-strong").trim() || "#f0f3ef";
    const ratio = Math.min(1, count / maxCount);
    const r = 70 + Math.round(ratio * 110);
    const g = 150 + Math.round(ratio * 85);
    const b = 90 + Math.round(ratio * 60);
    return `rgb(${r},${g},${b})`;
  }

  // Weeks: start from Sunday
  const weeks = [];
  let d = new Date(startDate);
  while (d <= endDate) {
    const week = [];
    for (let dow = 0; dow < 7; dow++) {
      const key = d.toISOString().slice(0, 10);
      week.push({ date: key, count: counts[key] || 0 });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }

  // Month labels
  const months = [];
  let lastMonth = -1;
  const MONTHS = t("graphs.monthLabels").split("|");
  for (let wi = 0; wi < weeks.length; wi++) {
    const m = new Date(weeks[wi][0].date).getMonth();
    if (m !== lastMonth) { months.push({ label: MONTHS[m], week: wi }); lastMonth = m; }
  }

  // Day labels (skip — not needed, just reserve space)
  let html = '<div class="heatmap-wrap"><div class="heatmap-day-labels" style="width:10px;"></div><div class="heatmap-grid-area">';
  html += '<div class="heatmap-months">';
  for (const m of months) {
    html += `<span style="position:absolute;left:${m.week * 17}px;">${m.label}</span>`;
  }
  html += '<span style="visibility:hidden;">' + MONTHS[0] + '</span></div>'; // reserve height
  html += '<div class="heatmap-grid">';
  for (const week of weeks) {
    html += '<div class="heatmap-week">';
    for (const day of week) {
      const c = color(day.count);
      const tip = day.date + ' · ' + day.count + ' ' + t("graphs.totalCards");
      html += `<div class="heatmap-cell" style="background:${c};" title="${tip}"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  // Legend
  html += `<div class="heatmap-legend">
    <span>${t("graphs.less")}</span>
    <span class="heatmap-legend-cell" style="background:${color(0)};"></span>
    <span class="heatmap-legend-cell" style="background:${color(Math.max(1, Math.ceil(maxCount * 0.25)))};"></span>
    <span class="heatmap-legend-cell" style="background:${color(Math.max(1, Math.ceil(maxCount * 0.5)))};"></span>
    <span class="heatmap-legend-cell" style="background:${color(Math.max(1, Math.ceil(maxCount * 0.75)))};"></span>
    <span class="heatmap-legend-cell" style="background:${color(maxCount)};"></span>
    <span>${t("graphs.more")}</span>
  </div>`;

  html += '</div></div>';
  el.innerHTML = html;
}

// ── Loading overlay ──
function setGraphsLoading(visible) {
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

// ── Main render ──
export function renderGraphs() {
  _chartEntries = Object.values(state.vocab);
  updateColors();
  const el = document.getElementById("graphs-canvas-area");
  if (!el) return;

  if (!Object.keys(state.vocab).length) {
    el.innerHTML = `<div class="empty-state" style="padding:3rem"><p>${t("graphs.empty")}</p></div>`;
    const heat = document.getElementById("graphs-heatmap");
    if (heat) heat.innerHTML = "";
    setGraphsLoading(false);
    return;
  }

  const containers = [
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
  for (const c of containers) html += `<div class="graph-cell"><canvas id="${c.id}"></canvas></div>`;
  el.innerHTML = html;

  setGraphsLoading(true);

  // Stagger rendering so each chart gets its own frame
  let idx = 0;
  function renderNext() {
    if (idx >= containers.length) {
      renderHeatmap();
      renderStatsSummary();
      setGraphsLoading(false);
      _chartEntries = null;
      return;
    }
    const c = containers[idx++];
    const ctx = canvas(c.id);
    if (ctx) c.fn(ctx);
    requestAnimationFrame(renderNext);
  }
  requestAnimationFrame(renderNext);
}

