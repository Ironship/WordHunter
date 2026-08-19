/**
 * "Explain with AI" for the Graphs view: serializes the current statistics
 * into plain text (the AI cannot see the charts) and streams back a
 * conclusions summary into a section below the graphs.
 */
import { state } from "../state.js";
import { todayISO } from "../sm2.js";
import {
  aiExplanationConfigured,
  aiExplanationLanguagePair,
  requestAiExplanationStream,
  formatAiExplanation
} from "../ai-explainer.js";
import { beginElementBusy } from "../loading.js";
import { t } from "../i18n.js";
import { buildHeatmapActivityCounts, daysBetween } from "./helpers.js";
import type { VocabEntry } from "./helpers.js";

/** Serialize the current vocabulary statistics as plain text for the LLM. */
function buildGraphsSummaryText(): string {
  const entries = Object.values(state.vocab) as VocabEntry[];
  const today = todayISO();
  let total = 0;
  let newCount = 0;
  let learning = 0;
  let known = 0;
  let ignored = 0;
  let due = 0;
  let overdue = 0;
  let mature = 0;
  const easeFactors: number[] = [];
  const intervals: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.status === "ignored") {
      ignored += 1;
      continue;
    }
    total += 1;
    if (entry.status === "new") newCount += 1;
    else if (entry.status === "learning") learning += 1;
    else if (entry.status === "known") known += 1;
    if (entry.status !== "known" && entry.nextDate) {
      const diff = daysBetween(entry.nextDate, today);
      if (diff < 0) overdue += 1;
      else if (diff === 0) due += 1;
    }
    if (entry.status !== "known" && (entry.interval || 0) >= 21) mature += 1;
    if (typeof entry.efactor === "number" && Number.isFinite(entry.efactor)) easeFactors.push(entry.efactor);
    const interval = entry.interval ?? 0;
    const bucket = interval <= 0 ? "0" : interval <= 1 ? "1" : interval <= 3 ? "2-3" : interval <= 7 ? "4-7" : interval <= 14 ? "8-14" : interval <= 30 ? "15-30" : "30+";
    intervals[bucket] = (intervals[bucket] || 0) + 1;
  }
  const activity = buildHeatmapActivityCounts(entries);
  const sortedDays = Object.keys(activity.counts).sort();
  const last30Days = sortedDays.slice(-30);
  const activeDays = last30Days.filter((day) => (activity.counts[day] || 0) > 0).length;
  const totalActivity = Object.values(activity.counts).reduce((sum, count) => sum + count, 0);
  const avgEase = easeFactors.length
    ? (easeFactors.reduce((sum, value) => sum + value, 0) / easeFactors.length).toFixed(2)
    : "n/a";
  const srsAlgorithm = state.preferences?.srsAlgorithm || "sm2";
  return [
    `Learning language: ${state.preferences.learningLanguage}`,
    `SRS algorithm: ${srsAlgorithm}`,
    `Total vocabulary entries: ${total} (new: ${newCount}, learning: ${learning}, known: ${known}, ignored: ${ignored})`,
    `Reviews due today: ${due}, overdue: ${overdue}`,
    `Mature words (interval >= 21 days): ${mature}`,
    `Average ease factor: ${avgEase}`,
    `Interval distribution in days: ${Object.entries(intervals).map(([bucket, count]) => `${bucket}d:${count}`).join(", ")}`,
    `Activity: ${activeDays} active days in the last 30 days, ${totalActivity} total recorded activity events`,
    `First recorded activity: ${activity.firstTime !== Infinity ? todayISO(new Date(activity.firstTime)) : "none"}`
  ].join("\n");
}

/** Run the AI graphs summary and stream it into the output section. */
export async function runGraphsAiExplain(button: HTMLButtonElement, output: HTMLElement): Promise<void> {
  if (!aiExplanationConfigured()) {
    output.hidden = false;
    output.textContent = t("graphs.aiExplainNotConfigured");
    return;
  }
  const releaseBusy = beginElementBusy(button, { disable: true });
  output.hidden = false;
  output.textContent = t("translator.translating");
  try {
    const pair = aiExplanationLanguagePair();
    const data = buildGraphsSummaryText();
    const result = await requestAiExplanationStream(
      { word: "your learning statistics", context: data, from: pair.from, to: pair.to, kind: "stats" },
      (text) => {
        if (output.isConnected) output.innerHTML = formatAiExplanation(text);
      }
    );
    if (output.isConnected) output.innerHTML = formatAiExplanation(result.explanation);
  } catch (error) {
    console.warn("AI graphs summary failed", error);
    if (output.isConnected) output.textContent = t("reader.aiExplainError");
  } finally {
    releaseBusy();
  }
}
