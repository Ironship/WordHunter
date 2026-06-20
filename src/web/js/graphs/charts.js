/**
 * Individual chart render functions for the graphs view.
 */
import { state } from "../state.js";
import { t } from "../i18n.js";
import {
  C, text, muted, blue, green, red, amber, panelBg, grid, labelMuted,
  DAYS, canvas, daysBetween, showTooltip, hideTooltip, drawBarChart
} from "./helpers.js";

export function renderDueForecast(_chartEntries) {
  const ctx = canvas("graph-due");
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
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) ctx.fillText(Math.round((i / 4) * maxVal), pad.left - 6, pad.top + ph - (i / 4) * ph);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let d = 0; d < DAYS; d += 5) {
    const x = dayStart + d * (barW + 3) + barW / 2;
    ctx.fillText(d === 0 ? t("graphs.today") : `+${d}`, x, H - pad.bottom + 16);
  }
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.dueForecast"), W / 2, 10);
  ctx.fillStyle = labelMuted; ctx.font = "11px Inter, sans-serif";
  ctx.fillText(t("graphs.totalReviews", { n: total, overdue }), W / 2, 24);

  const canv = document.getElementById("graph-due");
  if (canv) {
    canv.onmousemove = (e) => {
      const r = canv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      for (const a of hotAreas) {
        if (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h) { showTooltip(e, a.label); return; }
      }
      hideTooltip();
    };
    canv.onmouseleave = hideTooltip;
  }
}

export function renderStatusDonut(_chartEntries) {
  const ctx = canvas("graph-status");
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const cx = W / 2, cy = H / 2 + 6;
  const r = Math.min(W, H) / 2 - 36, ir = r * 0.58;
  const counts = { new: 0, learning: 0, known: 0 };
  for (const e of _chartEntries || Object.values(state.vocab)) if (counts[e.status] !== undefined) counts[e.status]++;
  const total = counts.new + counts.learning + counts.known || 1;
  const slices = [
    { status: "new", label: t("vocab.statusNew"), val: counts.new, color: C.new },
    { status: "learning", label: t("vocab.statusLearning"), val: counts.learning, color: C.learning },
    { status: "known", label: t("vocab.statusKnown"), val: counts.known, color: C.known }
  ].filter(s => s.val > 0);

  ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);
  let angle = -Math.PI / 2;
  for (const s of slices) {
    const slice = (s.val / total) * Math.PI * 2;
    s.start = angle;
    s.end = angle + slice;
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.arc(cx, cy, ir, angle + slice, angle, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    angle += slice;
  }
  ctx.fillStyle = text; ctx.font = "700 22px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(total, cx, cy - 4);
  ctx.fillStyle = labelMuted; ctx.font = "11px Inter, sans-serif";
  ctx.fillText(t("graphs.totalCards"), cx, cy + 16);
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

export function renderIntervalHistogram(_chartEntries) {
  const ctx = canvas("graph-intervals");
  if (!ctx) return;
  const binLabels = t("graphs.binIntervalLabels").split("|");
  const bins = binLabels.map(label => ({ label, val: 0 }));
  const limits = [-Infinity, 0, 3, 7, 14, 30, 90, Infinity];
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known" || !e.interval && e.interval !== 0) continue;
    for (let i = 0; i < bins.length; i++) if ((e.interval||0) >= limits[i] && (e.interval||0) <= limits[i+1]) { bins[i].val++; break; }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  bins.forEach(b => { b.color = blue; });
  drawBarChart(ctx, bins, maxVal, blue, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.intervals"), ctx.w / 2, 10);
}

export function renderEaseFactors(_chartEntries) {
  const ctx = canvas("graph-ease");
  if (!ctx) return;
  const easeLabels = t("graphs.binEaseLabels").split("|");
  const _easeColors = [red, blue, blue, blue, blue, green];
  // Contiguous upper-bound thresholds (gap-free). Bin 0 = leeches (minimum EF).
  const easeThresholds = [1.3, 1.6, 2.0, 2.5, 3.0, Infinity];
  const bins = easeLabels.map((label, i) => ({
    label: i === 0 ? t("graphs.leeches") : label, val: 0, color: _easeColors[i],
    max: easeThresholds[i]
  }));
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known") continue;
    const ef = e.efactor || 2.5;
    for (const b of bins) { if (ef <= b.max) { b.val++; break; } }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  drawBarChart(ctx, bins, maxVal, blue, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.easeDistribution"), ctx.w / 2, 10);
}

export function renderRepetitions(_chartEntries) {
  const ctx = canvas("graph-reps");
  if (!ctx) return;
  const repLabels = t("graphs.binRepsLabels").split("|");
  const bins = repLabels.map(label => ({ label, val: 0 }));
  const limits = [-Infinity, 0, 1, 3, 7, 15, Infinity];
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known") continue;
    for (let i = 0; i < bins.length; i++) if ((e.repetition||0) >= limits[i] && (e.repetition||0) <= limits[i+1]) { bins[i].val++; break; }
  }
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 48, right: 14, left: 44, bottom: 38 };
  bins.forEach(b => { b.color = green; });
  drawBarChart(ctx, bins, maxVal, green, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(t("graphs.repetitions"), ctx.w / 2, 10);
}

export function renderAddedOverTime(_chartEntries) {
  const ctx = canvas("graph-added");
  if (!ctx) return;
  const now = new Date();
  const bins = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    bins.push({ label: d.toLocaleDateString(undefined, { month: "short" }), val: 0, color: amber });
  }
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || !e.addedAt) continue;
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

export function renderDayOfWeek(_chartEntries) {
  const ctx = canvas("graph-dayofweek");
  if (!ctx) return;
  const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const W = ctx.w, H = ctx.h;
  const dayNames = DAY_KEYS.map((key) => t(`graphs.${key}`));
  const counts = new Array(7).fill(0);
  let total = 0;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || !e.addedAt && !e.lastReviewedAt) continue;
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
    if (counts[i] > 0) {
      ctx.fillStyle = text; ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(counts[i], x + barW / 2, Math.max(16, pad.top + ph - h - 4));
    }
    ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(dayNames[i], x + barW / 2, H - pad.bottom + 8);
  }
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.dayOfWeek"), W / 2, 10);
  ctx.textBaseline = "middle";
}

export function renderFsrsScatter(_chartEntries) {
  const ctx = canvas("graph-fsrs");
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const pad = { top: 34, right: 20, bottom: 54, left: 52 };
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  const points = [];
  let maxS = 0, maxD = 10;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known" || e.srsAlgorithm !== "fsrs") continue;
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
  const fmt = (v) => maxS < 10 ? v.toFixed(1) : Math.round(v).toString();
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) { ctx.fillText(fmt((i / 4) * maxS), pad.left - 6, pad.top + ph - (i / 4) * ph); }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) ctx.fillText(Math.round((i / 4) * maxD).toString(), pad.left + (i / 4) * pw, H - pad.bottom + 16);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = labelMuted; ctx.font = "10px Inter, sans-serif";
  ctx.fillText(t("graphs.difficulty"), pad.left + pw / 2, H - pad.bottom + 32);
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.save(); ctx.translate(10, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(t("graphs.stability"), 0, 0);
  ctx.restore();
  for (const p of points) {
    const x = pad.left + (p.d / maxD) * pw;
    const y = pad.top + ph - (p.s / maxS) * ph;
    ctx.fillStyle = blue; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText(t("graphs.fsrsTitle"), W / 2, 10);
}

export function renderMatureVsYoung(_chartEntries) {
  const ctx = canvas("graph-mature");
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const cx = W / 2, cy = H / 2 + 4;
  const r = Math.min(W, H) / 2 - 34, ir = r * 0.55;
  let young = 0, mature = 0;
  for (const e of _chartEntries || Object.values(state.vocab)) {
    if (e.status === "ignored" || e.status === "known") continue;
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
