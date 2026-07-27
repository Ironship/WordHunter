import {
  computeSignature,
  getCachedEntry,
  requestVocabIndex
} from "./vocab-index-client.js";
import { getTextStats } from "./tokenizer_v2.js";
import type { TextStats, Vocabulary } from "./tokenizer_v2.js";
import { getVocabularyRevision, state } from "./state.js";

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
  cacheGeneration: number;
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
const textStatsCache = new Map<string, TextStats>();
const textStatsSignatureByBookId = new Map<string, string>();
const pendingTextStats = new Map<string, TextStatsJob>();
const textStatsWaiters = new Map<string, Array<{
  resolve: (stats: TextStats) => void;
  reject: (error: Error) => void;
}>>();
let vocabStatuses = "";
let preparedStateVocabRevision = -1;
let statsWorker: Worker | null = null;
let activeTextStats: TextStatsJob | null = null;
let workerFailed = false;
let vocabVersion = 0;
let workerVocabVersion = -1;
let cacheGeneration = 0;

function currentVocabStatuses(vocab: Vocabulary): string {
  return JSON.stringify(Object.entries(vocab || {}).map(([word, entry]) => [word, entry?.status || "new"]));
}

function cancelPendingStats(reason: string): void {
  cacheGeneration += 1;
  pendingTextStats.clear();
  for (const waiters of textStatsWaiters.values()) {
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }
  textStatsWaiters.clear();
}

export function prepareTextStats(vocab: Vocabulary): string {
  if (vocab === state.vocab) {
    const revision = getVocabularyRevision();
    if (revision === preparedStateVocabRevision) return vocabStatuses;
    preparedStateVocabRevision = revision;
  }
  const nextVocabStatuses = currentVocabStatuses(vocab);
  if (nextVocabStatuses !== vocabStatuses) {
    textStatsCache.clear();
    textStatsSignatureByBookId.clear();
    cancelPendingStats("Vocabulary changed while statistics were being calculated");
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
    if (job?.id === data.id && job.vocabVersion === vocabVersion && job.cacheGeneration === cacheGeneration) {
      textStatsCache.set(job.signature, data.stats);
      for (const waiter of textStatsWaiters.get(job.signature) || []) waiter.resolve(data.stats);
      textStatsWaiters.delete(job.signature);
      notifyTextStatsLoaded();
    }
    runNextTextStats();
  };
  statsWorker.onerror = () => {
    const failedJob = activeTextStats;
    workerFailed = true;
    statsWorker = null;
    activeTextStats = null;
    pendingTextStats.clear();
    if (failedJob && failedJob.cacheGeneration === cacheGeneration) {
      const stats = getTextStats(failedJob.text, failedJob.vocab, failedJob.lang, failedJob.algorithm);
      textStatsCache.set(failedJob.signature, stats);
      for (const waiter of textStatsWaiters.get(failedJob.signature) || []) waiter.resolve(stats);
      textStatsWaiters.delete(failedJob.signature);
    }
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
  preparedVocabStatuses?: string,
  contentFingerprint = ""
): TextStats | Readonly<TextStats> | null {
  if (!text) return EMPTY_STATS;

  const signature = computeSignature(book, text, lang, algorithm, undefined, contentFingerprint);
  if (preparedVocabStatuses !== vocabStatuses) prepareTextStats(vocab);
  if (book.id) textStatsSignatureByBookId.set(book.id, signature);

  const cached = textStatsCache.get(signature);
  if (cached) return cached;

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
        vocabVersion,
        cacheGeneration
      });
      runNextTextStats();
    }
    return null;
  }

  // Fallback preserves phrase matching when Workers are unavailable.
  const stats = getTextStats(text, vocab, lang, algorithm);
  textStatsCache.set(signature, stats);
  return stats;
}

export function prepareBookTextStats(
  book: VocabBook,
  text: string,
  vocab: Vocabulary,
  lang: string,
  algorithm: string,
  preparedVocabStatuses: string,
  contentFingerprint = ""
): Promise<TextStats | Readonly<TextStats>> {
  const stats = getCachedTextStats(book, text, vocab, lang, algorithm, preparedVocabStatuses, contentFingerprint);
  if (stats) return Promise.resolve(stats);
  const signature = computeSignature(book, text, lang, algorithm, undefined, contentFingerprint);
  return new Promise((resolve, reject) => {
    const waiters = textStatsWaiters.get(signature) || [];
    waiters.push({ resolve, reject });
    textStatsWaiters.set(signature, waiters);
  });
}

export function getCachedBookTextStats(bookId: string): TextStats | null {
  const signature = textStatsSignatureByBookId.get(bookId);
  return signature ? textStatsCache.get(signature) || null : null;
}

export function invalidateTextStats(bookId?: string): void {
  cancelPendingStats("Book text statistics were invalidated");
  if (!bookId) {
    textStatsCache.clear();
    textStatsSignatureByBookId.clear();
    return;
  }
  const signature = textStatsSignatureByBookId.get(bookId);
  if (signature) {
    textStatsCache.delete(signature);
    pendingTextStats.delete(signature);
  }
  textStatsSignatureByBookId.delete(bookId);
}

export function getCachedUniqueWordCount(book: VocabBook, text: string, lang = "en", algorithm = "modern", vocab?: Vocabulary): number {
  if (!text) return 0;
  return getCachedEntry(computeSignature(book, text, lang, algorithm, vocab))?.stats.unique || 0;
}
