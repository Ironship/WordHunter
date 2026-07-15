import { STATE_SCHEMA_VERSION } from "./constants.js";

export const VOCAB_INDEX_CACHE_VERSION = 2;
const CACHE_KEY = `wordhunter:vocab-index:cache-v${VOCAB_INDEX_CACHE_VERSION}`;
const MAX_CACHE_ENTRIES = 80;
const SIGNATURE_VERSION = `vocab-index-v${VOCAB_INDEX_CACHE_VERSION}`;
const SAMPLE_PREFIX = 1536;
const SAMPLE_MIDDLE = 2048;
const SAMPLE_SUFFIX = 1536;
const SAMPLE_MIDDLE_OFFSET = 1024;
const MAX_FULL_SAMPLE = 4096;

interface VocabIndexCacheEntry {
  signature: string;
  bookId: string;
  stats: {
    unique: number;
    known: number;
    learning: number;
    ignored: number;
    new: number;
  };
  words: string[];
  tokenLine: string;
  lastUsed: number;
}

interface VocabIndexBook {
  id?: string;
  updatedAt?: string;
  createdAt?: string;
  textUrl?: string;
  localPath?: string;
}

interface VocabIndexPayload {
  unique: number;
  known: number;
  learning: number;
  ignored: number;
  new: number;
  words: string[];
  tokenLine: string;
}

interface VocabIndexRequest {
  text: string;
  vocab: unknown;
  lang: string;
  algorithm: string;
  book: VocabIndexBook;
}

interface PendingVocabIndexRequest {
  promise: Promise<VocabIndexCacheEntry | null>;
  bookId: string;
  generation: string;
}

let cache: Record<string, VocabIndexCacheEntry> = loadCache();
const pending = new Map<string, PendingVocabIndexRequest>();
const bookGenerations = new Map<string, number>();
let globalGeneration = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseStats(value: unknown): VocabIndexCacheEntry["stats"] | null {
  if (!isRecord(value)) return null;
  return {
    unique: finiteNumber(value.unique),
    known: finiteNumber(value.known),
    learning: finiteNumber(value.learning),
    ignored: finiteNumber(value.ignored),
    new: finiteNumber(value.new)
  };
}

function parseCacheEntry(value: unknown): VocabIndexCacheEntry | null {
  if (!isRecord(value) || typeof value.signature !== "string" || typeof value.bookId !== "string") return null;
  const stats = parseStats(value.stats);
  if (!stats) return null;
  return {
    signature: value.signature,
    bookId: value.bookId,
    stats,
    words: Array.isArray(value.words) ? value.words.filter((word): word is string => typeof word === "string") : [],
    tokenLine: typeof value.tokenLine === "string" ? value.tokenLine : "  ",
    lastUsed: finiteNumber(value.lastUsed)
  };
}

function parseVocabIndexPayload(value: unknown): VocabIndexPayload {
  if (!isRecord(value)) throw new Error("Invalid vocab_index response");
  return {
    unique: finiteNumber(value.unique),
    known: finiteNumber(value.known),
    learning: finiteNumber(value.learning),
    ignored: finiteNumber(value.ignored),
    new: finiteNumber(value.new),
    words: Array.isArray(value.words) ? value.words.filter((word): word is string => typeof word === "string") : [],
    tokenLine: typeof value.tokenLine === "string" ? value.tokenLine : "  "
  };
}

function currentGeneration(bookId: string): string {
  return `${globalGeneration}:${bookGenerations.get(bookId || "") || 0}`;
}

function loadCache(): Record<string, VocabIndexCacheEntry> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    if (!isRecord(parsed)) return {};
    const entries = Object.entries(parsed)
      .map(([key, value]) => [key, parseCacheEntry(value)] as const)
      .filter((entry): entry is readonly [string, VocabIndexCacheEntry] => entry[1] !== null);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function persistCache(): void {
  if (typeof localStorage === "undefined") return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      pruneCache();
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      const entries = Object.entries(cache).sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0));
      cache = Object.fromEntries(entries.slice(0, Math.floor(MAX_CACHE_ENTRIES / 2)));
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch {
        // Cache is an optimization; failure should never affect app behavior.
      }
    }
  }, 250);
}

function pruneCache(): void {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  cache = Object.fromEntries(
    entries
      .sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0))
      .slice(0, MAX_CACHE_ENTRIES)
  );
}

function sampleText(value: unknown): string {
  const text = String(value || "");
  if (text.length <= MAX_FULL_SAMPLE) return text;
  const middle = Math.max(0, Math.floor(text.length / 2) - SAMPLE_MIDDLE_OFFSET);
  return `${text.slice(0, SAMPLE_PREFIX)}|${text.slice(middle, middle + SAMPLE_MIDDLE)}|${text.slice(-SAMPLE_SUFFIX)}`;
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeSignature(
  book: VocabIndexBook | null | undefined,
  text: string,
  lang: string,
  algorithm: string
): string {
  const mode = algorithm === "classic" ? "classic" : "modern";
  return [
    SIGNATURE_VERSION,
    book?.id || "",
    lang || "",
    mode,
    book?.updatedAt || "",
    book?.createdAt || "",
    book?.textUrl || "",
    book?.localPath || "",
    String(text?.length || 0),
    fnv1a(sampleText(text))
  ].join("|");
}

export function getCachedEntry(signature: string): VocabIndexCacheEntry | null {
  const entry = cache[signature];
  if (entry) entry.lastUsed = Date.now();
  return entry || null;
}

function storeEntry(signature: string, bookId: string, data: VocabIndexPayload): void {
  cache[signature] = {
    signature,
    bookId: bookId || "",
    stats: {
      unique: data.unique,
      known: data.known,
      learning: data.learning,
      ignored: data.ignored,
      new: data.new
    },
    words: data.words || [],
    tokenLine: data.tokenLine || "  ",
    lastUsed: Date.now()
  };
  persistCache();
}

export function invalidateBookId(bookId: string): void {
  if (!bookId) return;
  bookGenerations.set(bookId, (bookGenerations.get(bookId) || 0) + 1);
  for (const [signature, request] of pending) {
    if (request.bookId === bookId) pending.delete(signature);
  }
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (cache[key]?.bookId === bookId) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) persistCache();
}

export function clearVocabIndexCache(): void {
  cache = {};
  globalGeneration += 1;
  bookGenerations.clear();
  pending.clear();
  persistCache();
}

async function fetchVocabIndex({ text, vocab, lang, algorithm, book }: VocabIndexRequest): Promise<VocabIndexPayload> {
  const response = await fetch("/__text/vocab_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, text, vocab, lang, algorithm, book })
  });
  if (!response.ok) throw new Error(`vocab_index HTTP ${response.status}`);
  const data: unknown = await response.json();
  return parseVocabIndexPayload(data);
}

export function requestVocabIndex({ text, vocab, lang, algorithm, book }: VocabIndexRequest): Promise<VocabIndexCacheEntry | null> {
  const signature = computeSignature(book, text, lang, algorithm);
  const bookId = book?.id || "";
  const generation = currentGeneration(bookId);
  const cached = getCachedEntry(signature);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(signature);
  if (existing?.generation === generation) return existing.promise;

  let promise: Promise<VocabIndexCacheEntry | null>;
  promise = fetchVocabIndex({ text, vocab, lang, algorithm, book })
    .then((data) => {
      if (currentGeneration(bookId) !== generation) return null;
      storeEntry(signature, bookId, data);
      window.dispatchEvent(new CustomEvent("vocab-index:loaded", {
        detail: { signature, bookId }
      }));
      return getCachedEntry(signature);
    })
    .catch((err: unknown): VocabIndexCacheEntry | null => {
      console.warn("vocab_index fetch failed", err);
      return null;
    })
    .finally(() => {
      if (pending.get(signature)?.promise === promise) pending.delete(signature);
    });

  pending.set(signature, { promise, bookId, generation });
  return promise;
}
