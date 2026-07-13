/**
 * Individual chart render functions for the graphs view.
 */
import { state } from "../state.js";
import { t } from "../i18n.js";
import { effectiveLearningLanguage } from "../translator-preferences.js";
import {
  C, text, muted, blue, green, red, amber, panelBg, grid, labelMuted,
  DAYS, canvas, daysBetween, showTooltip, hideTooltip, drawBarChart, drawChartBar, colorWithAlpha
} from "./helpers.js";

const CEFR_THRESHOLDS = {
  en: [500, 1000, 2000, 4000, 8000, 16000],
  de: [400, 800, 1800, 3500, 7000, 14000],
  fr: [500, 1000, 2000, 4000, 8000, 16000],
  es: [500, 1000, 2000, 4000, 8000, 16000],
  it: [500, 1000, 2000, 4000, 8000, 16000],
  pl: [400, 800, 1500, 3000, 6000, 12000],
  uk: [400, 800, 1500, 3000, 6000, 12000],
  ru: [400, 800, 1500, 3000, 6000, 12000],
  ja: [300, 800, 1500, 3000, 6000, 10000],
  zh: [200, 600, 1200, 2500, 5000, 9000],
};

const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const MS_PER_DAY = 86400000;

function getCefrThresholds(lang) {
  return CEFR_THRESHOLDS[lang] || CEFR_THRESHOLDS.en;
}

function getKnownWordCount(entries = Object.values(state.vocab || {})) {
  return entries.filter(e => e?.status === "known").length;
}

function getKnownLearningWordCount(entries = Object.values(state.vocab || {})) {
  return entries.filter(e => e?.status === "known" || e?.status === "learning").length;
}

function knownAt(entry) {
  const raw = entry?.knownAt || entry?.updatedAt || entry?.lastReviewedAt || entry?.addedAt;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function progressAt(entry) {
  if (entry?.status === "known") return knownAt(entry);
  const raw = entry?.updatedAt || entry?.addedAt || entry?.lastReviewedAt;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function buildWordSeries(entries, includeEntry, dateForEntry, width = 400, now = Date.now()) {
  const included = entries.filter(includeEntry);
  const dated = [];
  let undated = 0;
  for (const entry of included) {
    const time = dateForEntry(entry);
    if (time === null) undated++;
    else dated.push(time);
  }
  dated.sort((a, b) => a - b);

  if (!dated.length) {
    return [
      { t: now - MS_PER_DAY * 30, val: included.length },
      { t: now, val: included.length }
    ];
  }

  const start = dated[0];
  const end = Math.max(now, dated[dated.length - 1]);
  const series = [{ t: start - MS_PER_DAY * 7, val: undated }];
  let count = undated;
  for (let i = 0; i < dated.length;) {
    const t = dated[i];
    while (i < dated.length && dated[i] === t) { count++; i++; }
    series.push({ t, val: count });
  }
  if (series[series.length - 1].t < end) series.push({ t: end, val: included.length });
  return series;
}

export function buildKnownWordSeries(entries = Object.values(state.vocab || {}), width = 400, now = Date.now()) {
  return buildWordSeries(entries, e => e?.status === "known", knownAt, width, now);
}

export function buildKnownLearningWordSeries(entries = Object.values(state.vocab || {}), width = 400, now = Date.now()) {
  return buildWordSeries(entries, e => e?.status === "known" || e?.status === "learning", progressAt, width, now);
}

export function getCurrentLevel(count, thresholds) {
  let level = "Pre-A1";
  for (let i = 0; i < thresholds.length; i++) {
    if (count >= thresholds[i]) level = CEFR_LEVELS[i];
    else break;
  }
  return level;
}

function languageName(lang) {
  const label = t(`languages.${lang}`);
  return label === `languages.${lang}` ? lang.toUpperCase() : label;
}

export function formatVocabProgressDate(time, span, locale) {
  const options = span >= MS_PER_DAY * 365
    ? { month: "short", year: "numeric" }
    : { month: "short", day: "numeric" };
  return new Date(time).toLocaleDateString(locale, options);
}

function monthLabel(date) {
  return date.toLocaleDateString(undefined, { month: "short" });
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(start, end) {
  const months = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (d <= last) {
    months.push(new Date(d));
    d.setMonth(d.getMonth() + 1);
  }
  return months;
}

function rangeTitle(title, allTime) {
  return allTime ? `${title.replace(/\s*\([^)]*\)/, "")} · ${t("graphs.rangeAll")}` : title;
}

export function buildAddedOverTimeBins(entries = Object.values(state.vocab || {}), allTime = false, now = new Date()) {
  const dated = entries
    .filter(e => e?.status !== "ignored" && e?.addedAt)
    .map(e => new Date(e.addedAt))
    .filter(d => Number.isFinite(d.getTime()));

  if (!allTime) {
    const bins = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      bins.push({ key: monthKey(d), label: monthLabel(d), val: 0, color: amber });
    }
    const byKey = Object.fromEntries(bins.map(bin => [bin.key, bin]));
    for (const d of dated) if (byKey[monthKey(d)]) byKey[monthKey(d)].val++;
    return bins;
  }

  if (!dated.length) return [{ label: monthLabel(now), val: 0, color: amber }];
  const first = new Date(Math.min(...dated.map(d => d.getTime())));
  const monthSpan = (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth();
  if (monthSpan > 24) {
    const years = [];
    for (let y = first.getFullYear(); y <= now.getFullYear(); y++) years.push({ key: String(y), label: String(y), val: 0, color: amber });
    const byYear = Object.fromEntries(years.map(bin => [bin.key, bin]));
    for (const d of dated) if (byYear[String(d.getFullYear())]) byYear[String(d.getFullYear())].val++;
    return years;
  }

  const bins = monthRange(first, now).map(d => ({
    key: monthKey(d),
    label: d.getMonth() === 0 ? `${monthLabel(d)} ${d.getFullYear()}` : monthLabel(d),
    val: 0,
    color: amber
  }));
  const byKey = Object.fromEntries(bins.map(bin => [bin.key, bin]));
  for (const d of dated) if (byKey[monthKey(d)]) byKey[monthKey(d)].val++;
  return bins;
}

export function renderDueForecast(_chartEntries, options = {}) {
  const ctx = canvas("graph-due");
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const pad = { top: 52, right: 20, bottom: 40, left: 44 };
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  const today = new Date().toISOString().slice(0, 10);
  if (options.allTime) {
    const todayDate = new Date(`${today}T00:00:00`);
    let overdue = 0;
    let total = 0;
    let latest = todayDate;
    const counts = {};
    for (const e of _chartEntries || Object.values(state.vocab)) {
      if (e.status === "ignored" || e.status === "known" || !e.nextDate) continue;
      total++;
      const delta = daysBetween(e.nextDate, today);
      if (delta < 0) {
        overdue++;
        continue;
      }
      const d = new Date(`${e.nextDate}T00:00:00`);
      if (Number.isFinite(d.getTime())) {
        latest = latest > d ? latest : d;
        counts[monthKey(d)] = (counts[monthKey(d)] || 0) + 1;
      }
    }
    const monthSpan = (latest.getFullYear() - todayDate.getFullYear()) * 12 + latest.getMonth() - todayDate.getMonth();
    let bins;
    if (monthSpan > 24) {
      bins = [];
      for (let y = todayDate.getFullYear(); y <= latest.getFullYear(); y++) {
        bins.push({ key: String(y), label: String(y), val: 0, color: blue });
      }
      const byYear = Object.fromEntries(bins.map(bin => [bin.key, bin]));
      for (const [key, val] of Object.entries(counts)) {
        const year = key.slice(0, 4);
        if (byYear[year]) byYear[year].val += val;
      }
    } else {
      bins = monthRange(todayDate, latest).map((d) => ({
        key: monthKey(d),
        label: d.getMonth() === 0 ? `${monthLabel(d)} ${d.getFullYear()}` : monthLabel(d),
        val: counts[monthKey(d)] || 0,
        color: blue
      }));
    }
    if (overdue > 0) bins.unshift({ label: t("graphs.overdue"), val: overdue, color: red });
    const maxVal = Math.max(1, ...bins.map(b => b.val));
    drawBarChart(ctx, bins, maxVal, blue, pad);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif"; ctx.fillText(rangeTitle(t("graphs.dueForecast"), true), W / 2, 10);
    ctx.fillStyle = labelMuted; ctx.font = "11px Inter, sans-serif";
    ctx.fillText(t("graphs.totalReviews", { n: total, overdue }), W / 2, 24);
    return;
  }
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
    drawChartBar(ctx, bx, pad.top + ph - oh, barW, oh, red, 2);
    hotAreas.push({ x: bx, y: pad.top + ph - oh, w: barW, h: oh, label: overdue + ' ' + t("graphs.cards") });
    bx += barW + 3;
  }
  const dayStart = bx;
  for (let d = 0; d < DAYS; d++) {
    const h = (buckets[d] / maxVal) * ph;
    const x = bx + d * (barW + 3);
    const y = pad.top + ph - h;
    drawChartBar(ctx, x, y, barW, h, d === 0 ? green : blue, 2);
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
            import("../render.js").then(m => { state.filters.vocabStatuses = [s.status]; m.setView("vocabulary"); });
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

export function renderAddedOverTime(_chartEntries, options = {}) {
  const ctx = canvas("graph-added");
  if (!ctx) return;
  const bins = buildAddedOverTimeBins(_chartEntries || Object.values(state.vocab), options.allTime);
  const maxVal = Math.max(1, ...bins.map(b => b.val));
  const pad = { top: 50, right: 14, left: 44, bottom: 38 };
  drawBarChart(ctx, bins, maxVal, amber, pad);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = text; ctx.font = "600 12px Inter, sans-serif";
  ctx.fillText(rangeTitle(t("graphs.addedOverTime"), options.allTime), ctx.w / 2, 10);
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
    drawChartBar(ctx, x, pad.top + ph - h, barW, h, i === 0 ? green : blue);
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
    ctx.fillStyle = panelBg; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
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

export function renderVocabProgress(_chartEntries) {
  const ctx = canvas("graph-vocab-progress");
  if (!ctx) return;
  const W = ctx.w, H = ctx.h;
  const pad = { top: 52, right: 62, bottom: 48, left: 58 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const chartEntries = _chartEntries || Object.values(state.vocab || {});

  const lang = effectiveLearningLanguage(state.preferences).split("-")[0];
  const thresholds = getCefrThresholds(lang);
  const knownCount = getKnownWordCount(chartEntries);
  const knownLearningCount = getKnownLearningWordCount(chartEntries);
  const maxThreshold = thresholds[thresholds.length - 1];
  const logMax = Math.log10(Math.max(maxThreshold, knownCount, knownLearningCount, 10) * 1.15);
  const series = buildKnownWordSeries(chartEntries, pw);
  const potentialSeries = buildKnownLearningWordSeries(chartEntries, pw);
  const startTime = Math.min(series[0].t, potentialSeries[0].t);
  const endTime = Math.max(series[series.length - 1].t, potentialSeries[potentialSeries.length - 1].t);

  ctx.fillStyle = panelBg;
  ctx.fillRect(0, 0, W, H);

  const xScale = (t) => pad.left + ((t - startTime) / (endTime - startTime || 1)) * pw;
  const yScale = (v) => Math.log10(Math.max(v, 1)) / logMax;
  const yFor = (v) => pad.top + ph - yScale(v) * ph;

  // Standard gridlines at 0/25/50/75/100% of log scale (same pattern as renderDayOfWeek etc.)
  ctx.strokeStyle = grid;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
  }

  // CEFR threshold lines double as the Y axis.
  ctx.save();
  ctx.strokeStyle = green;
  ctx.fillStyle = text;
  ctx.lineWidth = 0.75;
  ctx.font = "600 10px Inter, sans-serif";
  ctx.textBaseline = "middle";
  for (let i = 0; i < thresholds.length; i++) {
    const y = yFor(thresholds[i]);
    if (y < pad.top + 4 || y > pad.top + ph - 4) continue;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.textAlign = "right";
    ctx.fillText(CEFR_LEVELS[i], pad.left - 8, y);
    ctx.textAlign = "left";
    ctx.fillStyle = labelMuted;
    ctx.fillText(thresholds[i].toLocaleString(), W - pad.right + 8, y);
    ctx.fillStyle = text;
  }
  ctx.restore();

  ctx.strokeRect(pad.left, pad.top, pw, ph);

  // --- Draw area + line ---
  const points = series.map(s => ({ x: xScale(s.t), y: yFor(s.val) }));
  const potentialPoints = potentialSeries.map(s => ({ x: xScale(s.t), y: yFor(s.val) }));

  ctx.beginPath();
  ctx.moveTo(points[0].x, pad.top + ph);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, pad.top + ph);
  ctx.closePath();
  const areaGrad = ctx.createLinearGradient(0, pad.top + ph, 0, pad.top);
  areaGrad.addColorStop(0, colorWithAlpha(green, 0.05));
  areaGrad.addColorStop(1, colorWithAlpha(green, 0.25));
  ctx.fillStyle = areaGrad;
  ctx.fill();

  if (knownLearningCount > knownCount) {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(potentialPoints[0].x, potentialPoints[0].y);
    for (let i = 1; i < potentialPoints.length; i++) ctx.lineTo(potentialPoints[i].x, potentialPoints[i].y);
    ctx.strokeStyle = blue;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = green;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const lastPx = points[points.length - 1].x;
  const lastPy = points[points.length - 1].y;

  // Current value label
  ctx.fillStyle = text;
  ctx.font = "600 11px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  // Check if label would overflow the right edge
  const labelW = ctx.measureText(`${knownCount.toLocaleString()} ${t("graphs.knownWords")}`).width;
  const lx = lastPx + (lastPx + 12 + labelW > W - pad.right ? -labelW - 14 : 10);
  const labelY = Math.max(pad.top + 14, Math.min(lastPy - 4, pad.top + ph - 18));
  ctx.fillText(`${knownCount.toLocaleString()} ${t("graphs.knownWords")}`, lx, labelY);

  const currentLevel = getCurrentLevel(knownCount, thresholds);
  ctx.fillStyle = green;
  ctx.font = "600 9px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`CEFR: ${currentLevel}`, lx, labelY + 4);

  const potentialLevel = getCurrentLevel(knownLearningCount, thresholds);
  if (knownLearningCount > knownCount) {
    const potentialLast = potentialPoints[potentialPoints.length - 1];
    const potentialText = `${knownLearningCount.toLocaleString()} ${t("vocab.statusKnown")} + ${t("vocab.statusLearning")} · ${potentialLevel}`;
    const potentialW = ctx.measureText(potentialText).width;
    const px = potentialLast.x + (potentialLast.x + 12 + potentialW > W - pad.right ? -potentialW - 14 : 10);
    const py = Math.max(pad.top + 16, Math.min(potentialLast.y - 4, pad.top + ph - 18));
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = blue;
    ctx.font = "600 10px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(potentialText, px, py);
    ctx.restore();
  }

  // X-axis dates
  ctx.fillStyle = labelMuted;
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const nLabels = Math.max(1, Math.min(5, Math.floor(pw / 70)));
  const timeSpan = endTime - startTime;
  for (let i = 0; i <= nLabels; i++) {
    const tick = startTime + timeSpan * (i / nLabels);
    ctx.fillText(formatVocabProgressDate(tick, timeSpan), xScale(tick), H - pad.bottom + 8);
  }

  // Title
  ctx.fillStyle = text;
  ctx.font = "600 12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(t("graphs.vocabProgress"), W / 2, 10);
  ctx.fillStyle = labelMuted;
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText(t("graphs.currentLevel", { level: currentLevel, lang: languageName(lang) }), W / 2, 24);

  // Tooltip
  const canv = document.getElementById("graph-vocab-progress");
  if (canv) {
    canv.onmousemove = (e) => {
      const r = canv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      if (mx >= pad.left && mx <= pad.left + pw && my >= pad.top && my <= pad.top + ph) {
        let nearest = points[0];
        let minDist = Infinity;
        for (const p of points) {
          const d = Math.abs(p.x - mx);
          if (d < minDist) { minDist = d; nearest = p; }
        }
        const idx = points.indexOf(nearest);
        const val = series[idx].val;
        let potentialIdx = 0;
        let potentialDist = Infinity;
        for (let i = 0; i < potentialPoints.length; i++) {
          const d = Math.abs(potentialPoints[i].x - mx);
          if (d < potentialDist) { potentialDist = d; potentialIdx = i; }
        }
        const potentialVal = potentialSeries[potentialIdx].val;
        const dateStr = new Date(series[idx].t)
          .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        const level = getCurrentLevel(val, thresholds);
        const nextVal = thresholds.find(t => t > val);
        const toNext = nextVal ? nextVal - val : 0;
        let tip = `${dateStr} · ${val.toLocaleString()} ${t("graphs.knownWords")} · ${level}`;
        if (potentialVal > val) {
          tip += ` · ${potentialVal.toLocaleString()} ${t("vocab.statusKnown")} + ${t("vocab.statusLearning")} · ${getCurrentLevel(potentialVal, thresholds)}`;
        }
        if (nextVal) tip += ` · ${toNext} ${t("graphs.toNextLevel")}`;
        showTooltip(e, tip);
        return;
      }
      hideTooltip();
    };
    canv.onmouseleave = hideTooltip;
  }
}

export { getCefrThresholds, getKnownWordCount, CEFR_LEVELS, CEFR_THRESHOLDS };
