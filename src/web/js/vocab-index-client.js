const CACHE_KEY = "wordhunter:vocab-index:v1";
const MAX_CACHE_ENTRIES = 80;
const SIGNATURE_VERSION = "v1";
const SAMPLE_PREFIX = 1536;
const SAMPLE_MIDDLE = 2048;
const SAMPLE_SUFFIX = 1536;
const SAMPLE_MIDDLE_OFFSET = 1024;
const MAX_FULL_SAMPLE = 4096;

let cache = loadCache();
const pending = new Map();
let saveTimer = null;

function loadCache() {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCache() {
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

function pruneCache() {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  cache = Object.fromEntries(
    entries
      .sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0))
      .slice(0, MAX_CACHE_ENTRIES)
  );
}

function sampleText(value) {
  const text = String(value || "");
  if (text.length <= MAX_FULL_SAMPLE) return text;
  const middle = Math.max(0, Math.floor(text.length / 2) - SAMPLE_MIDDLE_OFFSET);
  return `${text.slice(0, SAMPLE_PREFIX)}|${text.slice(middle, middle + SAMPLE_MIDDLE)}|${text.slice(-SAMPLE_SUFFIX)}`;
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeSignature(book, text, lang, algorithm) {
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

export function getCachedEntry(signature) {
  const entry = cache[signature];
  if (entry) entry.lastUsed = Date.now();
  return entry || null;
}

function storeEntry(signature, bookId, data) {
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

export function invalidateBookId(bookId) {
  if (!bookId) return;
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (cache[key]?.bookId === bookId) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) persistCache();
}

async function fetchVocabIndex({ text, vocab, lang, algorithm, book }) {
  const response = await fetch("/__text/vocab_index", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify({ text, vocab, lang, algorithm, book })
  });
  if (!response.ok) throw new Error(`vocab_index HTTP ${response.status}`);
  return response.json();
}

export function requestVocabIndex({ text, vocab, lang, algorithm, book }) {
  const signature = computeSignature(book, text, lang, algorithm);
  const cached = getCachedEntry(signature);
  if (cached) return Promise.resolve(cached);
  if (pending.has(signature)) return pending.get(signature);

  const promise = fetchVocabIndex({ text, vocab, lang, algorithm, book })
    .then((data) => {
      storeEntry(signature, book?.id || "", data);
      window.dispatchEvent(new CustomEvent("vocab-index:loaded", {
        detail: { signature, bookId: book?.id || "" }
      }));
      return getCachedEntry(signature);
    })
    .catch((err) => {
      console.warn("vocab_index fetch failed", err);
      return null;
    })
    .finally(() => pending.delete(signature));

  pending.set(signature, promise);
  return promise;
}
