import {
  computeSignature,
  getCachedEntry,
  requestVocabIndex
} from "./vocab-index-client.js";
import { getTextStats } from "./tokenizer_v2.js";

const EMPTY_STATS = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };
const textStatsCache = new Map();
const pendingTextStats = new Map();
let vocabStatuses = "";
let statsWorker;
let activeTextStats;
let workerFailed = false;
let vocabVersion = 0;
let workerVocabVersion = -1;

function currentVocabStatuses(vocab) {
  return JSON.stringify(Object.entries(vocab || {}).map(([word, entry]) => [word, entry?.status || "new"]));
}

export function prepareTextStats(vocab) {
  const nextVocabStatuses = currentVocabStatuses(vocab);
  if (nextVocabStatuses !== vocabStatuses) {
    textStatsCache.clear();
    pendingTextStats.clear();
    vocabStatuses = nextVocabStatuses;
    vocabVersion += 1;
  }
  return vocabStatuses;
}

function notifyTextStatsLoaded() {
  globalThis.window?.dispatchEvent?.(new CustomEvent("text-stats:loaded"));
}

function getStatsWorker() {
  if (workerFailed || typeof Worker === "undefined") return null;
  if (statsWorker) return statsWorker;
  try {
    statsWorker = new Worker(new URL("./stats-worker.js", import.meta.url), { type: "module" });
  } catch {
    workerFailed = true;
    return null;
  }
  statsWorker.onmessage = ({ data }) => {
    const job = activeTextStats;
    activeTextStats = null;
    if (job?.id === data.id && job.vocabVersion === vocabVersion) {
      textStatsCache.set(job.signature, { text: job.text, stats: data.stats });
      notifyTextStatsLoaded();
    }
    runNextTextStats();
  };
  statsWorker.onerror = () => {
    workerFailed = true;
    statsWorker = null;
    activeTextStats = null;
    pendingTextStats.clear();
    notifyTextStatsLoaded();
  };
  return statsWorker;
}

function runNextTextStats() {
  if (activeTextStats || !pendingTextStats.size) return;
  const worker = getStatsWorker();
  if (!worker) return;
  const [signature, job] = pendingTextStats.entries().next().value;
  pendingTextStats.delete(signature);
  activeTextStats = job;
  const { vocab, ...message } = job;
  if (workerVocabVersion !== job.vocabVersion) {
    message.vocab = Object.fromEntries(Object.entries(vocab || {}).map(([word, entry]) => [word, { status: entry?.status || "new" }]));
    workerVocabVersion = job.vocabVersion;
  }
  try {
    worker.postMessage(message);
  } catch {
    workerFailed = true;
    statsWorker = null;
    activeTextStats = null;
    pendingTextStats.clear();
    notifyTextStatsLoaded();
  }
}

export function getCachedTextStats(book, text, vocab, lang = "en", algorithm = "modern", preparedVocabStatuses) {
  if (!text) return EMPTY_STATS;

  const signature = computeSignature(book, text, lang, algorithm);
  if (preparedVocabStatuses !== vocabStatuses) prepareTextStats(vocab);

  const cached = textStatsCache.get(signature);
  if (cached?.text === text) return cached.stats;

  const worker = getStatsWorker();
  if (worker) {
    if (activeTextStats?.signature !== signature && !pendingTextStats.has(signature)) {
      pendingTextStats.set(signature, {
        id: `${signature}|${Date.now()}`,
        signature,
        text,
        vocab,
        lang,
        algorithm,
        vocabVersion
      });
      runNextTextStats();
    }
    return null;
  }

  // Fallback preserves phrase matching when Workers are unavailable.
  const stats = getTextStats(text, vocab, lang, algorithm);
  textStatsCache.set(signature, { text, stats });
  return stats;
}

export function getCachedUniqueWordCount(book, text, lang = "en", algorithm = "modern") {
  if (!text) return 0;
  return getCachedEntry(computeSignature(book, text, lang, algorithm))?.stats.unique || 0;
}
