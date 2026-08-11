import { fetchWithTimeout } from "./request.js";

export const VOCAB_INDEX_CACHE_VERSION = 4;
const CACHE_KEY = `wordhunter:vocab-index:cache-v${VOCAB_INDEX_CACHE_VERSION}`;
const MAX_CACHE_ENTRIES = 80;
const SIGNATURE_VERSION = `vocab-index-v${VOCAB_INDEX_CACHE_VERSION}`;

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
  indexVersion: number;
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
  contentFingerprint?: string;
  vocabRevision?: number;
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
const phraseFingerprints = new WeakMap<object, { revision: number; fingerprint: string }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requiredFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStats(value: unknown): VocabIndexCacheEntry["stats"] | null {
  if (!isRecord(value)) return null;
  const unique = requiredFiniteNumber(value.unique);
  const known = requiredFiniteNumber(value.known);
  const learning = requiredFiniteNumber(value.learning);
  const ignored = requiredFiniteNumber(value.ignored);
  const next = requiredFiniteNumber(value.new);
  if (unique === null || known === null || learning === null || ignored === null || next === null) return null;
  return {
    unique,
    known,
    learning,
    ignored,
    new: next
  };
}

function parseCacheEntry(value: unknown): VocabIndexCacheEntry | null {
  if (!isRecord(value) || typeof value.signature !== "string" || typeof value.bookId !== "string") return null;
  const stats = parseStats(value.stats);
  if (!stats) return null;
  if (!Array.isArray(value.words) || !value.words.every((word) => typeof word === "string") || typeof value.tokenLine !== "string") return null;
  return {
    signature: value.signature,
    bookId: value.bookId,
    stats,
    words: value.words,
    tokenLine: value.tokenLine,
    lastUsed: finiteNumber(value.lastUsed)
  };
}

function parseVocabIndexPayload(value: unknown): VocabIndexPayload {
  if (!isRecord(value)) throw new Error("Invalid vocab_index response");
  const stats = parseStats(value);
  if (value.indexVersion !== VOCAB_INDEX_CACHE_VERSION
    || !stats
    || !Array.isArray(value.words)
    || !value.words.every((word) => typeof word === "string")
    || typeof value.tokenLine !== "string") {
    throw new Error("Incompatible vocab_index response");
  }
  return {
    indexVersion: VOCAB_INDEX_CACHE_VERSION,
    ...stats,
    words: value.words,
    tokenLine: value.tokenLine
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
  algorithm: string,
  vocab?: unknown,
  contentFingerprint = "",
  vocabRevision = -1
): string {
  const mode = algorithm === "classic" ? "classic" : "modern";
  const cachedPhrases = isRecord(vocab) && vocabRevision >= 0 ? phraseFingerprints.get(vocab) : null;
  const phraseFingerprint = cachedPhrases?.revision === vocabRevision
    ? cachedPhrases.fingerprint
    : fnv1a(isRecord(vocab)
      ? Object.entries(vocab).flatMap(([key, entry]) => {
      const values = [key];
      if (isRecord(entry) && typeof entry.word === "string") values.push(entry.word);
      return values.map((value) => value.trim().replace(/\s+/g, " ")).filter((value) => value.includes(" "));
      }).sort().join("\n")
      : "");
  if (isRecord(vocab) && vocabRevision >= 0 && cachedPhrases?.revision !== vocabRevision) {
    phraseFingerprints.set(vocab, { revision: vocabRevision, fingerprint: phraseFingerprint });
  }
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
    contentFingerprint || fnv1a(text),
    phraseFingerprint
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
  const compactVocab = isRecord(vocab)
    ? Object.fromEntries(Object.entries(vocab).map(([key, entry]) => [key, isRecord(entry)
      ? { status: typeof entry.status === "string" ? entry.status : "new", ...(typeof entry.word === "string" ? { word: entry.word } : {}) }
      : { status: "new" }]))
    : {};
  const response = await fetchWithTimeout("/__text/vocab_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify({ text, vocab: compactVocab, lang, algorithm })
  }, 30_000);
  if (!response.ok) throw new Error(`vocab_index HTTP ${response.status}`);
  const data: unknown = await response.json();
  return parseVocabIndexPayload(data);
}

export function requestVocabIndex(request: VocabIndexRequest): Promise<VocabIndexCacheEntry | null> {
  const { text, vocab, lang, algorithm, book, contentFingerprint = "", vocabRevision = -1 } = request;
  const signature = computeSignature(book, text, lang, algorithm, vocab, contentFingerprint, vocabRevision);
  const bookId = book?.id || "";
  const generation = currentGeneration(bookId);
  const cached = getCachedEntry(signature);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(signature);
  if (existing?.generation === generation) return existing.promise;

  let promise: Promise<VocabIndexCacheEntry | null>;
  promise = fetchVocabIndex(request)
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
