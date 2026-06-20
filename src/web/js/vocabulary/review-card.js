/**
 * Review card: flashcard rendering, grading, SRS meta.
 */
import { state, saveState } from "../state.js";
import { els } from "../dom.js";
import { escapeHtml, escapeAttribute, clamp } from "../utils.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { applyReviewNative, isDue, todayISO } from "../sm2.js";
import { renderContributionHeatmap } from "../views/heatmap.js";
import { renderVocabulary } from "./vocab-list.js";

import { reviewAnswerVisible } from "../views/vocabulary.js";

export function renderReview() {
  if (!els.reviewCard) return;
  const today = todayISO();
  const srsEntries = Object.entries(state.vocab)
    .filter(([, entry]) => {
      if (entry.status === "ignored" || entry.status === "known") return false;
      if (state.preferences?.autoAddLearningOnly && entry.status === "new") return false;
      return true;
    })
    .map(([word, entry]) => ({ word, ...entry, nextDate: entry.nextDate || today }))
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const reviewWords = srsEntries.filter((entry) => isDue(entry.nextDate, today));

  renderReviewChart(srsEntries, today);
  renderReviewUpcoming(srsEntries, today);

  const labelEl = document.getElementById("review-reverse-label");
  if (labelEl) {
    const isReverse = !!state.preferences.reviewReverse;
    labelEl.textContent = isReverse ? t("vocab.reverseOrder") : t("vocab.normalOrder");
    labelEl.setAttribute("data-i18n", isReverse ? "vocab.reverseOrder" : "vocab.normalOrder");
  }

  if (!reviewWords.length) {
    els.reviewCard.innerHTML = `<div class="empty-state"><p class="eyebrow">${escapeHtml(t("vocab.reviewEyebrow"))}</p><h3>${escapeHtml(t("vocab.reviewEmptyHeading"))}</h3><p>${escapeHtml(t("vocab.reviewEmptyHint"))}</p></div>`;
    return;
  }

  state.reviewIndex = clamp(state.reviewIndex || 0, 0, reviewWords.length - 1);
  saveState();
  const card = reviewWords[state.reviewIndex];
  const grades = [0, 1, 2, 3, 4, 5];
  const ratingButtons = grades.map((q) => `
    <button class="status-button sm2-grade sm2-grade-${q}" type="button" data-sm2-grade="${q}" data-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t(`sm2.grade${q}`))}">${q}</button>
  `).join("");

  const context = card.examples?.[0] || "";
  const displayContext = context.length > 120 ? context.slice(0, 117) + "…" : context;
  const isReverse = !!state.preferences.reviewReverse;

  let frontHtml = "";
  if (!isReverse) {
    frontHtml = `
      <strong style="font-size: 2rem; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
        ${escapeHtml(card.word)}
        <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
          ${icon("speaker", 14)}
        </button>
      </strong>
      ${context ? `
        <p class="review-context" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.75rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
          „${escapeHtml(displayContext)}”
          <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
            ${icon("speaker", 12)}
          </button>
        </p>
      ` : ""}
    `;
  } else {
    frontHtml = `
      ${card.translation ? `
        <p class="review-translation-front" style="font-size: 1.5rem; font-weight: 500; color: var(--ink); margin-top: 0.5rem; display: block; width: 100%; text-align: center;">
          ${escapeHtml(card.translation)}
        </p>
      ` : renderReviewTranslationInput(card)}
      ${context ? `
        <p class="review-context" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.75rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
          „${escapeHtml(maskWordInSentence(displayContext, card.word))}”
        </p>
      ` : ""}
    `;
  }

  let imageHtml = "";
  if (card.imageUrl) {
    imageHtml = `
      <div class="review-image" style="margin-top: 0.5rem; text-align: center; position: relative; display: inline-block;">
        <img src="${escapeAttribute(card.imageUrl)}" style="max-height: 120px; max-width: 100%; border-radius: 6px; border: 1px solid var(--line);" />
        <button type="button" data-action="remove-image" data-word="${escapeAttribute(card.word)}" style="position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; font-size: 12px; line-height: 1; border: none; background: var(--red); color: white; cursor: pointer;">×</button>
      </div>
    `;
  } else {
    imageHtml = `
      <div class="review-image-search" style="margin-top: 0.5rem; text-align: center;">
        <button class="secondary-button button-xs image-action-button" type="button" data-review-action="search-image" data-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("vocab.addImage"))}">
          ${icon("image", 14)}
          ${escapeHtml(t("vocab.addImage"))}
          <span class="shortcut-badge">I</span>
        </button>
        <div id="review-image-search-results-${escapeAttribute(card.word)}" style="margin-top: 0.25rem;"></div>
      </div>
    `;
  }

  let backHtml = "";
  if (reviewAnswerVisible) {
    if (!isReverse) {
      backHtml = `
        ${card.translation ? `
          <p class="review-translation" style="margin-top: 1rem; font-size: 1.2rem; font-weight: 500; color: var(--ink);">${escapeHtml(card.translation)}</p>
        ` : renderReviewTranslationInput(card)}
        ${card.note ? `<p class="review-note" style="margin-top: 0.5rem; color: var(--muted); font-size: 0.95rem;">${escapeHtml(card.note)}</p>` : ""}
      `;
    } else {
      backHtml = `
        <strong style="font-size: 2rem; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%; margin-top: 1rem;">
          ${escapeHtml(card.word)}
          <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.ttsWordTitle"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
            ${icon("speaker", 14)}
          </button>
        </strong>
        ${context ? `
          <p class="review-context-unmasked" style="font-size: 0.9rem; color: var(--muted); margin-top: 0.5rem; font-style: italic; display: inline-flex; align-items: center; gap: 0.5rem; justify-content: center; width: 100%;">
            „${escapeHtml(displayContext)}”
            <button class="secondary-button" type="button" data-tts-word="${escapeAttribute(context)}" title="${escapeAttribute(t("vocab.readSentence"))}" style="padding: 0.2rem; min-height: auto; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--line); color: var(--muted); cursor: pointer;">
              ${icon("speaker", 12)}
            </button>
          </p>
        ` : ""}
        ${card.note ? `<p class="review-note" style="margin-top: 0.5rem; color: var(--muted); font-size: 0.95rem;">${escapeHtml(card.note)}</p>` : ""}
      `;
    }
  }

  const scheduleMeta = formatSrsMeta(card);

  els.reviewCard.innerHTML = `
    <div class="review-word">
      <div>
        ${frontHtml}
        ${imageHtml}
        ${backHtml}
      </div>
    </div>
    <div class="word-actions" style="flex-wrap: wrap;">
      <button class="secondary-button" type="button" data-dict-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("vocab.openDictionary"))}">
        ${icon("book", 16)}
        <span class="shortcut-badge">M</span>
      </button>
      <button class="secondary-button" type="button" data-youglish-word="${escapeAttribute(card.word)}" title="${escapeAttribute(t("reader.youglishWordTitle"))}">
        ${icon("video", 16)}
        <span class="shortcut-badge">Y</span>
      </button>
      <button class="secondary-button" type="button" data-review-action="toggle" data-word="${escapeAttribute(card.word)}">
        ${icon("eye", 16)}
        ${escapeHtml(reviewAnswerVisible ? t("vocab.reviewHide") : t("vocab.reviewShow"))}
        <span class="shortcut-badge">Enter</span>
      </button>
      <button class="secondary-button" type="button" id="btn-flashcard-prev" data-review-action="prev" data-word="${escapeAttribute(card.word)}" ${state.reviewIndex === 0 ? "disabled" : ""}>
        ${icon("chevronLeft", 16)}
        ${escapeHtml(t("vocab.reviewPrev"))}
        <span class="shortcut-badge">←</span>
      </button>
      <button class="secondary-button" type="button" id="btn-flashcard-next" data-review-action="next" data-word="${escapeAttribute(card.word)}">
        ${escapeHtml(t("vocab.reviewNext"))}
        <span class="shortcut-badge">→</span>
        ${icon("chevronRight", 16)}
      </button>
    </div>
    ${reviewAnswerVisible ? `
      <p class="muted-copy sm2-prompt">${escapeHtml(t("sm2.prompt"))}</p>
      <div class="sm2-grades">${ratingButtons}</div>
    ` : ""}
    <p class="muted-copy">${state.reviewIndex + 1} / ${reviewWords.length} · ${escapeHtml(t("sm2.nextDue", { date: card.nextDate || today }))} · ${escapeHtml(scheduleMeta)}</p>
  `;
}

export async function gradeReview(word, quality) {
  const entry = state.vocab[word];
  if (!entry) return;
  await applyReviewNative(entry, quality, new Date(), state.preferences?.srsAlgorithm || "sm2");
  entry.updatedAt = new Date().toISOString();
  if (quality >= 4 && entry.repetition >= 2) entry.status = "known";
  else if (quality < 3) entry.status = "learning";
  else if (entry.status === "new") entry.status = "learning";
  saveState();
  const { hideReviewAnswer } = await import("../views/vocabulary.js");
  hideReviewAnswer();
  state.reviewIndex = 0;
  renderReview();
}

export function removeFromSrs(word) {
  const entry = state.vocab[word];
  if (!entry) return;
  entry.status = "ignored";
  entry.updatedAt = new Date().toISOString();
  saveState();
  state.reviewIndex = 0;
  renderReview();
  renderVocabulary();
}

function formatSrsMeta(entry) {
  const mode = state.preferences?.srsAlgorithm === "fsrs" || entry.srsAlgorithm === "fsrs" ? "fsrs" : "sm2";
  if (mode === "fsrs") {
    const stability = Number.isFinite(entry.stability) ? entry.stability : 0;
    const difficulty = Number.isFinite(entry.difficulty) ? entry.difficulty : 5;
    return t("vocab.fsrsMeta", { stability: stability.toFixed(2), difficulty: difficulty.toFixed(2) });
  }
  const efactor = Number.isFinite(entry.efactor) ? entry.efactor : 2.5;
  return t("vocab.sm2Meta", { efactor: efactor.toFixed(2) });
}

function maskWordInSentence(sentence, word) {
  if (!sentence || !word) return sentence;
  const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  try {
    let regex;
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\uFAFF\uFF66-\uFF9F]/.test(word)) {
      regex = new RegExp(escapedWord, 'gi');
    } else {
      regex = new RegExp(`(?<!\\p{L})${escapedWord}(?!\\p{L})`, 'gui');
    }
    return sentence.replace(regex, '_____');
  } catch (e) {
    return sentence.replace(new RegExp(escapedWord, 'gi'), '_____');
  }
}

function renderReviewTranslationInput(card) {
  return `
    <input
      class="vocab-translation-input review-translation-input empty"
      type="text"
      value=""
      data-word="${escapeAttribute(card.word)}"
      data-word-field="translation"
      placeholder="${escapeAttribute(t("vocab.addTranslationPlaceholder"))}"
      aria-label="${escapeAttribute(t("vocab.addTranslationAria", { word: card.word }))}"
      autocomplete="off"
      spellcheck="false">
  `;
}

// --- Chart rendering for review section ---

function diffDays(fromISO, toISO) {
  // Interpret date-only strings as UTC midnight so the day difference is stable
  // across host time zones and DST transitions.
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86400000);
}

function renderReviewChart(srsEntries, today) {
  if (!els.reviewChart) return;
  const graphType = state.preferences?.reviewGraphType || "heatmap";

  if (graphType === "heatmap") {
    els.reviewChart.innerHTML = '<div id="review-heatmap" class="review-heatmap"></div>';
    const hEl = document.getElementById("review-heatmap");
    if (!hEl) return;

    const due = {};
    for (const e of srsEntries) {
      const d = e.nextDate;
      if (!d) continue;
      due[d] = (due[d] || 0) + 1;
    }
    renderContributionHeatmap(hEl, {
      getValue: (isoDate) => due[isoDate],
      tooltip: (isoDate, count) => `${isoDate} · ${t("vocab.cardCount", { count })}`
    });
  } else {
    els.reviewChart.innerHTML = `<div class="review-chart-frame"><canvas id="review-chart-canvas" style="width:100%;height:160px;display:block;"></canvas></div>`;
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
      const pad = { top: 22, right: 12, left: 36, bottom: 28 };
      const ph = H - pad.top - pad.bottom;

      const s = getComputedStyle(document.documentElement);
      const bg = s.getPropertyValue("--panel").trim() || "#fff";
      const ink = s.getPropertyValue("--ink").trim() || "#1a201d";
      const muted = s.getPropertyValue("--muted").trim() || "#6b726e";
      const grn = s.getPropertyValue("--green").trim() || "#4fb38e";
      const blu = s.getPropertyValue("--blue").trim() || "#6faae0";

      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

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
        const pw = W - pad.left - pad.right;
        let bx = pad.left;
        if (overdue > 0) {
          const h = (overdue / maxVal) * ph;
          ctx.fillStyle = s.getPropertyValue("--red") || "#e37e76";
          ctx.beginPath(); ctx.roundRect(bx, pad.top + ph - h, barW, h, [2,2,0,0]); ctx.fill();
          ctx.fillStyle = ink; ctx.font = "bold 9px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(overdue, bx + barW / 2, pad.top + ph - h - 2);
          bx += barW + 3;
        }
        for (let d = 0; d < days; d++) {
          const h = (buckets[d] / maxVal) * ph;
          ctx.fillStyle = d === 0 ? grn : blu;
          ctx.beginPath(); ctx.roundRect(bx + d * (barW + 3), pad.top + ph - h, barW, h, [2,2,0,0]); ctx.fill();
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
        const bins = [{v:0},{v:0},{v:0},{v:0},{v:0},{v:0},{v:0}];
        const limits = [-Infinity,0,3,7,14,30,90,Infinity];
        for (const e of srsEntries) {
          for (let i = 0; i < 7; i++) if ((e.interval||0) >= limits[i] && (e.interval||0) <= limits[i+1]) { bins[i].v++; break; }
        }
        const maxVal = Math.max(1, ...bins.map(b=>b.v));
        const pw = W - pad.left - pad.right;
        const barW = pw / 7 - 4;
        const labels = t("graphs.binIntervalLabels").split("|");
        for (let i=0;i<7;i++){
          const h = (bins[i].v/maxVal)*ph;
          const x = pad.left + i*(pw/7)+2;
          ctx.fillStyle = blu;
          ctx.beginPath(); ctx.roundRect(x, pad.top+ph-h, barW, Math.max(h,0.5), [3,3,0,0]); ctx.fill();
          ctx.fillStyle = ink; ctx.font="9px Inter,sans-serif"; ctx.textAlign="center"; ctx.textBaseline="top";
          ctx.fillText(labels[i], x+barW/2, H-pad.bottom+8);
          if(bins[i].v>0){ctx.fillStyle=ink;ctx.fillText(bins[i].v, x+barW/2, pad.top+ph-h-4);}
        }
      } else if (graphType === "easeDistribution") {
        const bins = [{v:0,c:s.getPropertyValue("--red")||"#e37e76"},{v:0,c:blu},{v:0,c:blu},{v:0,c:blu},{v:0,c:blu},{v:0,c:grn}];
        for (const e of srsEntries) {
          const ef = e.efactor||2.5;
          if (ef<=1.3) bins[0].v++;
          else if (ef<=1.6) bins[1].v++;
          else if (ef<=2.0) bins[2].v++;
          else if (ef<=2.5) bins[3].v++;
          else if (ef<=3.0) bins[4].v++;
          else bins[5].v++;
        }
        const maxVal = Math.max(1, ...bins.map(b=>b.v));
        const pw = W-pad.left-pad.right;
        const barW = pw/6-4;
        const easeLabels = t("graphs.binEaseLabels").split("|");
        const labels = easeLabels.map((l, i) => i === 0 ? t("graphs.leeches") : l);
        for (let i=0;i<6;i++){
          const h = (bins[i].v/maxVal)*ph;
          ctx.fillStyle=bins[i].c;
          ctx.beginPath(); ctx.roundRect(pad.left+i*(pw/6)+2, pad.top+ph-h, barW, Math.max(h,0.5), [3,3,0,0]); ctx.fill();
          ctx.fillStyle=ink;ctx.font="9px Inter,sans-serif";ctx.textAlign="center";ctx.textBaseline="top";
          ctx.fillText(labels[i], pad.left+i*(pw/6)+2+barW/2, H-pad.bottom+8);
          if(bins[i].v>0){ctx.fillText(bins[i].v, pad.left+i*(pw/6)+2+barW/2, pad.top+ph-h-4);}
        }
      } else if (graphType === "repetitions") {
        const bins = [{v:0},{v:0},{v:0},{v:0},{v:0},{v:0}];
        const limits = [-Infinity,0,1,3,7,15,Infinity];
        for (const e of srsEntries) {
          for (let i=0;i<6;i++) if ((e.repetition||0)>=limits[i] && (e.repetition||0)<=limits[i+1]) { bins[i].v++; break; }
        }
        const maxVal = Math.max(1, ...bins.map(b=>b.v));
        const pw=W-pad.left-pad.right;
        const barW=pw/6-4;
        const labels = t("graphs.binRepsLabels").split("|");
        for(let i=0;i<6;i++){
          const h=(bins[i].v/maxVal)*ph;
          ctx.fillStyle=grn;
          ctx.beginPath();ctx.roundRect(pad.left+i*(pw/6)+2,pad.top+ph-h,barW,Math.max(h,0.5),[3,3,0,0]);ctx.fill();
          ctx.fillStyle=ink;ctx.font="9px Inter,sans-serif";ctx.textAlign="center";ctx.textBaseline="top";
          ctx.fillText(labels[i],pad.left+i*(pw/6)+2+barW/2,H-pad.bottom+8);
          if(bins[i].v>0){ctx.fillText(bins[i].v,pad.left+i*(pw/6)+2+barW/2,pad.top+ph-h-4);}
        }
      }
    });
  }
}

function renderReviewUpcoming(srsEntries, today) {
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
