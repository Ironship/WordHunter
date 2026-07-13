import {
  computeSignature,
  getCachedEntry,
  requestVocabIndex
} from "./vocab-index-client.js";
import { getTextStats } from "./tokenizer_v2.js";
import type { TextStats, Vocabulary } from "./tokenizer_v2.js";

interface VocabBook {
  id?: string;
  updatedAt?: string;
  createdAt?: string;
  textUrl?: string;
  localPath?: string;
}

interface TextStatsJob {
  id: string;
  signature: string;
  text: string;
  vocab: Vocabulary;
  lang: string;
  algorithm: string;
  vocabVersion: number;
}

interface StatsWorkerRequest {
  id: string;
  text: string;
  lang: string;
  algorithm: string;
  vocab?: Vocabulary;
}

interface StatsWorkerResponse {
  id: string;
  stats: TextStats;
}

const EMPTY_STATS: Readonly<TextStats> = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };
const textStatsCache = new Map<string, { text: string; stats: TextStats }>();
const pendingTextStats = new Map<string, TextStatsJob>();
let vocabStatuses = "";
let statsWorker: Worker | null = null;
let activeTextStats: TextStatsJob | null = null;
let workerFailed = false;
let vocabVersion = 0;
let workerVocabVersion = -1;

function currentVocabStatuses(vocab: Vocabulary): string {
  return JSON.stringify(Object.entries(vocab || {}).map(([word, entry]) => [word, entry?.status || "new"]));
}

export function prepareTextStats(vocab: Vocabulary): string {
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

function getStatsWorker(): Worker | null {
  if (workerFailed || typeof Worker === "undefined") return null;
  if (statsWorker) return statsWorker;
  try {
    statsWorker = new Worker(new URL("./stats-worker.js", import.meta.url), { type: "module" });
  } catch {
    workerFailed = true;
    return null;
  }
  statsWorker.onmessage = ({ data }: MessageEvent<StatsWorkerResponse>) => {
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
  const nextJob = pendingTextStats.entries().next();
  if (nextJob.done) return;
  const [signature, job] = nextJob.value;
  pendingTextStats.delete(signature);
  activeTextStats = job;
  const message: StatsWorkerRequest = {
    id: job.id,
    text: job.text,
    lang: job.lang,
    algorithm: job.algorithm
  };
  if (workerVocabVersion !== job.vocabVersion) {
    message.vocab = Object.fromEntries(Object.entries(job.vocab || {}).map(([word, entry]) => [word, { status: entry?.status || "new" }]));
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

export function getCachedTextStats(
  book: VocabBook,
  text: string,
  vocab: Vocabulary,
  lang = "en",
  algorithm = "modern",
  preparedVocabStatuses?: string
): TextStats | Readonly<TextStats> | null {
  if (!text) return EMPTY_STATS;

  const signature = computeSignature(book, text, lang, algorithm);
  if (preparedVocabStatuses !== vocabStatuses) prepareTextStats(vocab);

  const cached = textStatsCache.get(signature);
  if (cached?.text === text) return cached.stats;

  const worker = getStatsWorker();
  if (worker) {
    const activeJobIsCurrent = activeTextStats?.signature === signature
      && activeTextStats.vocabVersion === vocabVersion;
    if (!activeJobIsCurrent && !pendingTextStats.has(signature)) {
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

export function getCachedUniqueWordCount(book: VocabBook, text: string, lang = "en", algorithm = "modern"): number {
  if (!text) return 0;
  return getCachedEntry(computeSignature(book, text, lang, algorithm))?.stats.unique || 0;
}
