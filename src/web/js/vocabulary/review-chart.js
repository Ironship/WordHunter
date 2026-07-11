/**
 * Review-section charts: due forecast / intervals / ease / repetitions bars,
 * contribution heatmap, and the upcoming-reviews list.
 *
 * Colors and the no-grid bar-chart variant are shared with the Graphs view via
 * graphs/helpers.js so the palette and basic canvas drawing stay in one place.
 *
 * diffDays is kept local (UTC-midnight parsing) rather than reusing
 * graphs/helpers.js::daysBetween (local-midnight parsing): the two disagree
 * around DST transitions and across host time zones.
 */
import { state } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute } from "../utils.js";
import { t } from "../i18n.js";
import { renderContributionHeatmap } from "../views/heatmap.js";
import { buildHeatmapActivityCounts, drawBarChart, drawChartBar, updateColors, text as ink, muted, blue, green, red, panelBg } from "../graphs/helpers.js";
import { formatSrsMeta } from "./review-card.js";

function diffDays(fromISO, toISO) {
  // Interpret date-only strings as UTC midnight so the day difference is stable
  // across host time zones and DST transitions.
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86400000);
}

export function renderReviewChart(srsEntries, today) {
  if (!els.reviewChart) return;
  const graphType = state.preferences?.reviewGraphType || "heatmap";

  if (graphType === "heatmap") {
    els.reviewChart.innerHTML = '<div id="review-heatmap" class="review-heatmap"></div>';
    const hEl = document.getElementById("review-heatmap");
    if (!hEl) return;

    const { counts: activity } = buildHeatmapActivityCounts(Object.values(state.vocab || {}));
    renderContributionHeatmap(hEl, {
      getValue: (isoDate) => activity[isoDate],
      tooltip: (isoDate, count) => `${isoDate} · ${t("vocab.cardCount", { count })}`
    });
  } else {
    els.reviewChart.innerHTML = `<div class="review-chart-frame"><canvas id="review-chart-canvas" class="chart-reveal" style="width:100%;height:160px;display:block;"></canvas></div>`;
    requestAnimationFrame(() => {
      const c = document.getElementById("review-chart-canvas");
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(280, Math.min(860, c.parentElement.clientWidth || 860));
      const H = 160;
      c.width = W * dpr; c.height = H * dpr;
      c.style.width = "100%"; c.style.height = H + "px";
      const ctx = c.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.w = W; ctx.h = H;
      const pad = { top: 22, right: 12, left: 36, bottom: 28 };
      const ph = H - pad.top - pad.bottom;

      updateColors();

      ctx.fillStyle = panelBg; ctx.fillRect(0, 0, W, H);

      if (graphType === "dueForecast") {
        const days = 21;
        const buckets = new Array(days).fill(0);
        let overdue = 0;
        for (const e of srsEntries) {
          const delta = diffDays(e.nextDate, today);
          if (delta < 0) overdue++;
          else if (delta < days) buckets[delta]++;
        }
        const maxVal = Math.max(1, overdue, ...buckets);
        const barW = Math.max(3, (W - pad.left - pad.right) / (days + (overdue > 0 ? 1 : 0)) - 3);
        let bx = pad.left;
        if (overdue > 0) {
          const h = (overdue / maxVal) * ph;
          drawChartBar(ctx, bx, pad.top + ph - h, barW, h, red, 2);
          ctx.fillStyle = ink; ctx.font = "bold 9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(overdue, bx + barW / 2, pad.top + ph - h - 2);
          bx += barW + 3;
        }
        for (let d = 0; d < days; d++) {
          const h = (buckets[d] / maxVal) * ph;
          drawChartBar(ctx, bx + d * (barW + 3), pad.top + ph - h, barW, h, d === 0 ? green : blue, 2);
          if (buckets[d] > 0 && barW > 10) {
            ctx.fillStyle = ink; ctx.font = "bold 9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
            ctx.fillText(buckets[d], bx + d * (barW + 3) + barW / 2, pad.top + ph - h - 2);
          }
        }
        ctx.fillStyle = muted; ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (let d = 0; d < days; d += 5) {
          ctx.fillText(d === 0 ? t("graphs.today") : `+${d}`, bx + d * (barW + 3) + barW / 2, H - pad.bottom + 4);
        }
      } else if (graphType === "intervals") {
        const labels = t("graphs.binIntervalLabels").split("|");
        const bins = labels.map((label) => ({ val: 0, label }));
        const limits = [-Infinity,0,3,7,14,30,90,Infinity];
        for (const e of srsEntries) {
          for (let i = 0; i < 7; i++) if ((e.interval||0) >= limits[i] && (e.interval||0) <= limits[i+1]) { bins[i].val++; break; }
        }
        drawBarChart(ctx, bins, Math.max(1, ...bins.map((bin) => bin.val)), blue, pad, { minimal: true });
      } else if (graphType === "easeDistribution") {
        const easeLabels = [t("graphs.leeches"), ...t("graphs.binEaseLabels").split("|")];
        const bins = easeLabels.map((label, index) => ({ val: 0, color: index === 0 ? red : index === 5 ? green : blue, label }));
        for (const e of srsEntries) {
          const ef = e.efactor||2.5;
          if (ef<=1.3) bins[0].val++;
          else if (ef<=1.6) bins[1].val++;
          else if (ef<=2.0) bins[2].val++;
          else if (ef<=2.5) bins[3].val++;
          else if (ef<=3.0) bins[4].val++;
          else bins[5].val++;
        }
        drawBarChart(ctx, bins, Math.max(1, ...bins.map((bin) => bin.val)), blue, pad, { minimal: true });
      } else if (graphType === "repetitions") {
        const bins = t("graphs.binRepsLabels").split("|").map((label) => ({ val: 0, label }));
        const limits = [-Infinity,0,1,3,7,15,Infinity];
        for (const e of srsEntries) {
          for (let i=0;i<6;i++) if ((e.repetition||0)>=limits[i] && (e.repetition||0)<=limits[i+1]) { bins[i].val++; break; }
        }
        drawBarChart(ctx, bins, Math.max(1, ...bins.map((bin) => bin.val)), green, pad, { minimal: true });
      }
    });
  }
}

export function renderReviewUpcoming(srsEntries, today) {
  if (!els.reviewUpcoming) return;
  if (!srsEntries.length) {
    els.reviewUpcoming.innerHTML = `<p class="empty-row">${escapeHtml(t("vocab.upcomingEmpty"))}</p>`;
    return;
  }
  const rows = srsEntries.slice(0, 30).map((entry) => {
    const delta = diffDays(entry.nextDate, today);
    let when;
    if (delta < 0) when = t("vocab.upcomingOverdue", { days: -delta });
    else if (delta === 0) when = t("vocab.upcomingToday");
    else if (delta === 1) when = t("vocab.upcomingTomorrow");
    else when = t("vocab.upcomingInDays", { days: delta });
    const due = delta <= 0 ? " due" : "";
    return `<li class="upcoming-row${due}">
      <div class="upcoming-main">
        <strong>${escapeHtml(entry.word)}</strong>
        <span class="upcoming-meta">${escapeHtml(entry.nextDate)} · ${escapeHtml(when)} · ${escapeHtml(formatSrsMeta(entry))} · ${t("vocab.repetitionsAbbr")} ${entry.repetition || 0}</span>
      </div>
      <button type="button" class="icon-button" data-srs-remove="${escapeAttribute(entry.word)}" title="${escapeAttribute(t("vocab.upcomingRemoveTitle"))}" aria-label="${escapeAttribute(t("vocab.upcomingRemoveTitle"))}">×</button>
    </li>`;
  }).join("");
  const more = srsEntries.length > 30 ? `<p class="muted-copy">${escapeHtml(t("vocab.upcomingMore", { count: srsEntries.length - 30 }))}</p>` : "";
  els.reviewUpcoming.innerHTML = `<ul class="upcoming-list">${rows}</ul>${more}`;
}
