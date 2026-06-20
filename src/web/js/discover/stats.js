/**
 * Stats fetching for Gutendex books.
 * Maintains a concurrent fetch queue for vocabulary stats of discovered books.
 */
import { state } from "../state.js";
import { getTextStats, cleanGutenbergText } from "../tokenizer_v2.js";

export const discoverStats = new Map();

const FETCH_CONCURRENCY = 2;
const STATS_TEXT_LIMIT = 80000;
let activeFetches = 0;
const fetchQueue = [];
const activeFetchControllers = new Map();

/**
 * Enqueue a text fetch for stats computation.
 * @param {string} id - gutenberg book id
 * @param {string} textUrl - URL to fetch the text from
 */
export function queueStatsFetch(id, textUrl) {
  fetchQueue.push({ id, textUrl });
  processQueue();
}

function processQueue() {
  while (activeFetches < FETCH_CONCURRENCY && fetchQueue.length > 0) {
    const { id, textUrl } = fetchQueue.shift();
    activeFetches++;
    const controller = new AbortController();
    activeFetchControllers.set(id, controller);
    fetchTextForStats(id, textUrl, controller.signal)
      .finally(() => {
        activeFetches--;
        activeFetchControllers.delete(id);
        processQueue();
      });
  }
}

async function fetchTextForStats(id, textUrl, signal) {
  try {
    const body = await fetch(textUrl, { signal }).then((r) => r.text());
    if (!body || body.length > STATS_TEXT_LIMIT) return;
    const cleaned = cleanGutenbergText(body);
    const wordAlgorithm = state.preferences.wordDetectionAlgorithm || "modern";
    const stats = getTextStats(cleaned, state.vocab, state.preferences.learningLanguage || "en", wordAlgorithm);
    discoverStats.set(id, stats);
    // Re-render just this card
    const card = document.querySelector(`.discover-card[data-id="${CSS.escape(id)}"] .stats-block`);
    if (card) {
      const pcts = calcStatsPcts(stats);
      card.innerHTML = renderStatsPct(pcts, stats.unique);
    }
  } catch (e) {
    if (e.name !== "AbortError") console.warn("Stats fetch failed for", id, e);
  }
}

/** Abort all in-flight stats fetches and reset. */
export function cancelAllStatsFetches() {
  for (const c of activeFetchControllers.values()) c.abort();
  activeFetchControllers.clear();
  fetchQueue.length = 0;
  activeFetches = 0;
}

function calcStatsPcts(stats) {
  const total = stats.unique || 1;
  return {
    knownPct: Math.round(((stats.knownCount || 0) / total) * 100),
    learningPct: Math.round(((stats.learningCount || 0) / total) * 100),
    newPct: Math.round(((stats.newCount || 0) / total) * 100)
  };
}

function renderStatsPct(pcts, unique) {
  return `<span class="tag tag-soft">${pcts.knownPct}%</span>`;
}
