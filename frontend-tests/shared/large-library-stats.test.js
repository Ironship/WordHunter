import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Perf-smoke harness for the library statistics pipeline (stats-cache.js).
 * Static imports are synthetic mocks; the REAL dist chunks loaded here are
 * stats-cache.js itself and vocab-index-client.js (signature + entry cache).
 *
 * The tokenizer is mocked because the real wasm-free JS tokenizer costs
 * ~3-4s for 200 books × 3000 words on its own, which would swallow the very
 * budgets this test guards. The mock keeps the documented counting
 * semantics (per-occurrence status buckets, distinct-word `unique`) so the
 * correctness fixture below is still meaningful, while the wall-clock
 * measurement targets the caching layer where O(n²)-style regressions live
 * (vocab-status serialization, signature computation, cache/book-id maps).
 */
async function evaluateStatsCache({ state, getVocabularyRevision, getTextStats }) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    performance,
    window: { dispatchEvent() {} },
    CustomEvent: class {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  });
  const modules = new Map();
  const createMock = (specifier, values) => new vm.SyntheticModule(
    Object.keys(values),
    function initialize() {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    },
    { context, identifier: `mock:${specifier}` }
  );
  const mocks = {
    // Deps of the real stats-cache chunk.
    "./state.js": { state, getVocabularyRevision },
    "./tokenizer_v2.js": { getTextStats },
    // Dep of the real vocab-index-client chunk (never reached: the
    // worker-less fallback path below performs no network requests).
    "./http.js": { httpPost: async () => { throw new Error("no network in perf smoke"); } }
  };
  for (const [specifier, values] of Object.entries(mocks)) {
    modules.set(specifier, createMock(specifier, values));
  }
  const realModules = {
    "./vocab-index-client.js": "dist/web/js/vocab-index-client.js"
  };
  for (const [specifier, file] of Object.entries(realModules)) {
    modules.set(specifier, new vm.SourceTextModule(read(file), {
      context,
      identifier: new URL(`../../${file}`, import.meta.url).href
    }));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(read("dist/web/js/stats-cache.js"), {
    context,
    identifier: new URL("../../dist/web/js/stats-cache.js", import.meta.url).href,
    importModuleDynamically: async (specifier) => {
      const dependency = getModule(specifier);
      if (dependency.status === "unlinked") await dependency.link(() => {});
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    }
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

/**
 * Mirrors tokenizer_v2's TextStats contract for single-word tokens:
 * `unique` counts distinct normalized words, the status buckets count
 * token OCCURRENCES classified via the vocabulary entry status.
 */
function makeTokenizerCounter() {
  const counter = { calls: 0 };
  const pattern = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  const getTextStats = (text, vocab = {}) => {
    counter.calls += 1;
    const stats = { unique: 0, known: 0, learning: 0, ignored: 0, new: 0 };
    const seen = new Set();
    for (const raw of String(text).match(pattern) || []) {
      const word = raw.toLowerCase();
      if (!seen.has(word)) {
        seen.add(word);
        stats.unique += 1;
      }
      const status = vocab[word]?.status;
      stats[status === "known" || status === "learning" || status === "ignored" ? status : "new"] += 1;
    }
    return stats;
  };
  return { counter, getTextStats };
}

function makeHarness() {
  const { counter, getTextStats } = makeTokenizerCounter();
  const namespacePromise = evaluateStatsCache({
    state: { vocab: {} },
    getVocabularyRevision: () => 1,
    getTextStats
  });
  return { counter, ready: namespacePromise };
}

// Deterministic synthetic corpus: BOOKS books of WORDS_PER_BOOK tokens drawn
// from a VOCAB_SIZE vocabulary (no randomness, stable across runs/CI).
const BOOKS = 200;
const WORDS_PER_BOOK = 3000;
const VOCAB_SIZE = 2000;

function makeVocab() {
  const vocab = {};
  const statuses = ["known", "learning", "new"];
  for (let i = 0; i < VOCAB_SIZE; i++) {
    vocab[`word${i}`] = { status: i % 7 === 0 ? "ignored" : statuses[i % 3] };
  }
  return vocab;
}

function makeBooks() {
  const books = [];
  for (let b = 0; b < BOOKS; b++) {
    const words = [];
    for (let w = 0; w < WORDS_PER_BOOK; w++) {
      words.push(`word${(w * 7 + b * 13) % VOCAB_SIZE}`);
    }
    const text = `${words.join(" ")} booktail${b}`;
    // Books with a known content fingerprint skip the fallback full-text
    // fnv1a hash inside computeSignature — the same path the library uses
    // for imported books. (Inside the vm harness a cross-realm charCode
    // loop is an order of magnitude slower than in a browser, which would
    // measure the harness, not the pipeline.)
    books.push({
      book: { id: `book-${b}`, updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
      text,
      fingerprint: `fp-${b}-${text.length}`
    });
  }
  return books;
}

describe("library stats pipeline at scale (perf smoke)", () => {
  it("computes known-word percentages correctly on a controlled fixture", async () => {
    const { ready } = makeHarness();
    const { prepareTextStats, getCachedTextStats, getCachedBookTextStats } = await ready;

    const vocab = { alpha: { status: "known" }, beta: { status: "learning" } };
    const book = { id: "tiny-fixture" };
    const prepared = prepareTextStats(vocab);
    const stats = getCachedTextStats(book, "Alpha beta alpha gamma", vocab, "en", "classic", prepared);

    // Occurrence buckets: alpha×2 known, beta×1 learning, gamma×1 new.
    assert.deepEqual({ ...stats }, { unique: 3, known: 2, learning: 1, ignored: 0, new: 1 });
    const classified = stats.known + stats.learning + stats.ignored + stats.new;
    assert.equal(classified, 4);
    assert.equal(Math.round((100 * stats.known) / classified), 50, "known share must be 2 of 4 occurrences");
    // The book-id → signature map must resolve the freshly prepared stats.
    assert.equal(getCachedBookTextStats("tiny-fixture"), stats);
  });

  it("prepares 200 books x ~3000 words under budget and serves a cached pass without re-tokenizing", async () => {
    const { counter, ready } = makeHarness();
    const { prepareTextStats, getCachedTextStats, getCachedBookTextStats } = await ready;

    const vocab = makeVocab();
    const books = makeBooks();
    const prepared = prepareTextStats(vocab);

    const firstPass = [];
    const t0 = performance.now();
    for (const { book, text, fingerprint } of books) {
      const stats = getCachedTextStats(book, text, vocab, "en", "classic", prepared, fingerprint);
      assert.ok(stats, `stats must be produced synchronously without a Worker for ${book.id}`);
      assert.equal(typeof stats.unique, "number");
      firstPass.push(stats);
    }
    const firstMs = performance.now() - t0;

    // Every book id must be resolvable through the secondary index.
    let viaBookId = 0;
    for (const [index, { book }] of books.entries()) {
      if (getCachedBookTextStats(book.id) === firstPass[index]) viaBookId += 1;
    }
    assert.equal(viaBookId, BOOKS, "getCachedBookTextStats must resolve every prepared book");

    assert.equal(counter.calls, BOOKS, "the tokenizer must run exactly once per book");

    const t1 = performance.now();
    const cachedPass = books.map(({ book, text, fingerprint }, index) =>
      getCachedTextStats(book, text, vocab, "en", "classic", prepared, fingerprint));
    const cachedMs = performance.now() - t1;

    // Cache hits must return the exact same stats objects, never recomputed.
    for (let i = 0; i < BOOKS; i++) {
      assert.equal(cachedPass[i], firstPass[i], `cached pass must reuse stats for book-${i}`);
    }
    assert.equal(counter.calls, BOOKS, "the cached pass must not tokenize anything");

    console.log(`[large-library-stats] first pass: ${firstMs.toFixed(1)} ms, cached pass: ${cachedMs.toFixed(1)} ms (${BOOKS} books x ${WORDS_PER_BOOK} words, vocab ${VOCAB_SIZE})`);
    // Generous budgets so slow CI runners stay non-flaky; a quadratic
    // regression blows past them by orders of magnitude.
    assert.ok(firstMs < 4000, `first pass took ${firstMs.toFixed(1)} ms (budget 4000 ms)`);
    assert.ok(cachedMs < 400, `cached pass took ${cachedMs.toFixed(1)} ms (budget 400 ms)`);
  });
});
