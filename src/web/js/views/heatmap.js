// GitHub-style contribution heatmap renderer shared between Graphs and Flashcards views.
// Produces identical markup/styling; callers supply the data source and tooltip.
import { t } from "../i18n.js";
import { escapeHtml, escapeAttribute } from "../utils.js";

export function buildContributionMonthLabels(weeks, weeksToShow, monthLabels) {
  const months = [];
  let lastMonth = -1;
  for (let wi = 0; wi < weeks.length; wi++) {
    const weekDate = new Date(weeks[wi][0].date);
    const m = weekDate.getMonth();
    if (m === lastMonth) continue;

    const year = weekDate.getFullYear();
    const label = weeksToShow > 60 && (m === 0 || wi === 0) ? `${monthLabels[m]} ${year}` : monthLabels[m];
    const previous = months[months.length - 1];
    if (previous && wi - previous.week < 2) {
      if (previous.week === 0) months[months.length - 1] = { label, week: wi };
      lastMonth = m;
      continue;
    }
    months.push({ label, week: wi });
    lastMonth = m;
  }
  return months;
}

export function renderContributionHeatmap(target, options = {}) {
  const {
    getValue,        // (isoDate: string) => number
    tooltip,         // (isoDate: string, count: number) => string
    weeksToShow = 52,
    legend = true
  } = options;
  if (!target) return;

  const now = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - startDate.getDay() - (weeksToShow - 1) * 7);

  const weeks = [];
  let d = new Date(startDate);
  while (d <= endDate) {
    const week = [];
    for (let dow = 0; dow < 7; dow++) {
      const key = d.toISOString().slice(0, 10);
      week.push({ date: key, count: getValue ? getValue(key) || 0 : 0 });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }

  const maxCount = Math.max(1, ...weeks.flatMap(w => w.map(day => day.count)));
  const levels = [
    0,
    Math.max(1, Math.ceil(maxCount * 0.25)),
    Math.max(2, Math.ceil(maxCount * 0.5)),
    Math.max(3, Math.ceil(maxCount * 0.75))
  ];

  function color(count) {
    if (count === 0) return "var(--panel-strong)";
    const ratio = Math.min(1, count / maxCount);
    return `color-mix(in srgb, var(--control-accent) ${Math.round(22 + ratio * 78)}%, var(--panel-strong))`;
  }

  const MONTHS = t("graphs.monthLabels").split("|");
  const months = buildContributionMonthLabels(weeks, weeksToShow, MONTHS);

  let html = '<div class="heatmap-wrap"><div class="heatmap-day-labels" style="width:10px;"></div><div class="heatmap-grid-area">';
  html += '<div class="heatmap-months">';
  for (const m of months) {
    html += `<span style="position:absolute;left:${m.week * 17}px;">${escapeHtml(m.label)}</span>`;
  }
  html += '<span style="visibility:hidden;">' + escapeHtml(MONTHS[0]) + '</span></div>';
  html += '<div class="heatmap-grid">';
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex];
    html += '<div class="heatmap-week">';
    for (let dayIndex = 0; dayIndex < week.length; dayIndex += 1) {
      const day = week[dayIndex];
      const c = color(day.count);
      const tip = tooltip ? tooltip(day.date, day.count) : `${day.date} · ${day.count}`;
      const delay = Math.min(weekIndex * 6 + dayIndex * 2, 320);
      html += `<div class="heatmap-cell" style="--heatmap-delay:${delay}ms;background:${c};" title="${escapeAttribute(tip)}"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  if (legend) {
    html += `<div class="heatmap-legend">
      <span>${escapeHtml(t("graphs.less"))}</span>
      <span class="heatmap-legend-cell" style="background:${color(0)};"></span>
      <span class="heatmap-legend-cell" style="background:${color(levels[1])};"></span>
      <span class="heatmap-legend-cell" style="background:${color(levels[2])};"></span>
      <span class="heatmap-legend-cell" style="background:${color(levels[3])};"></span>
      <span class="heatmap-legend-cell" style="background:${color(maxCount)};"></span>
      <span>${escapeHtml(t("graphs.more"))}</span>
    </div>`;
  }

  html += '</div></div>';
  target.innerHTML = html;
}
