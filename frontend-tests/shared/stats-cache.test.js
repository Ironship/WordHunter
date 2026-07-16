import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { STATE_SCHEMA_VERSION } = await import("../../dist/web/js/constants.js");
const { getCachedTextStats, getCachedUniqueWordCount } = await import("../../dist/web/js/stats-cache.js");
const { computeSignature, invalidateBookId, requestVocabIndex, VOCAB_INDEX_CACHE_VERSION } = await import("../../dist/web/js/vocab-index-client.js");
const { getTextStats } = await import("../../dist/web/js/tokenizer_v2.js");

describe("cached unique word count", () => {
  it("reads the count without starting another vocabulary lookup", async () => {
    let requests = 0;
    let requestBody = null;
    globalThis.fetch = async (_url, init) => {
      requests += 1;
      requestBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ unique: 2, known: 1, learning: 0, ignored: 0, new: 1 }) };
    };
    const book = { id: "cached-book" };
    await requestVocabIndex({ book, text: "one two", vocab: {}, lang: "en", algorithm: "modern" });
    assert.equal(getCachedUniqueWordCount(book, "one two", "en", "modern"), 2);
    assert.equal(requests, 1);
    assert.equal(requestBody.schemaVersion, STATE_SCHEMA_VERSION);
    assert.match(computeSignature(book, "one two", "en", "modern"), new RegExp(`^vocab-index-v${VOCAB_INDEX_CACHE_VERSION}\\|`));
  });

  it("keeps backend vocab index results when cache persistence hits quota", async () => {
    let writes = 0;
    let requests = 0;
    globalThis.localStorage = {
      getItem() { return null; },
      setItem() {
        writes += 1;
        throw new Error("quota exceeded");
      }
    };
    globalThis.fetch = async () => {
      requests += 1;
      return {
        ok: true,
        json: async () => ({ unique: 1, known: 0, learning: 1, ignored: 0, new: 0, words: ["quota"] })
      };
    };

    const request = {
      book: { id: "quota-book" },
      text: "quota unique text",
      vocab: { quota: { status: "learning" } },
      lang: "en",
      algorithm: "modern"
    };
    const result = await requestVocabIndex(request);
    await new Promise((resolve) => setTimeout(resolve, 320));
    const cached = await requestVocabIndex(request);

    assert.equal(result.stats.unique, 1);
    assert.equal(cached.stats.unique, 1);
    assert.equal(requests, 1);
    assert.ok(writes >= 1);
  });

  it("does not let an invalidated request repopulate a book index", async () => {
    const responses = [];
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return new Promise((resolve) => responses.push(resolve));
    };
    const request = {
      book: { id: "edited-while-pending" },
      text: "same signature text",
      vocab: {},
      lang: "en",
      algorithm: "modern"
    };

    const stale = requestVocabIndex(request);
    invalidateBookId(request.book.id);
    const fresh = requestVocabIndex(request);
    assert.equal(requests, 2);
    responses[0]({ ok: true, json: async () => ({ unique: 1, known: 1, learning: 0, ignored: 0, new: 0 }) });
    responses[1]({ ok: true, json: async () => ({ unique: 2, known: 0, learning: 0, ignored: 0, new: 2 }) });

    assert.equal(await stale, null);
    assert.equal((await fresh).stats.unique, 2);
  });
});

describe("cached text stats", () => {
  it("keeps complete counts and refreshes them after word or phrase status changes", () => {
    globalThis.Worker = undefined;
    const book = { id: "exact-stats" };
    const text = "One two one two";
    const vocab = { one: { status: "known" }, "one two": { status: "learning" } };

    assert.deepEqual(getCachedTextStats(book, text, vocab), {
      unique: 2, known: 0, learning: 4, ignored: 0, new: 0
    });
    vocab["one two"].status = "ignored";
    assert.deepEqual(getCachedTextStats(book, text, vocab), {
      unique: 2, known: 0, learning: 0, ignored: 4, new: 0
    });
  });

  it("queues fresh counters when vocabulary changes during an active worker job", async () => {
    const jobs = [];
    const events = [];
    let worker;
    window.dispatchEvent = (event) => events.push(event.type);
    globalThis.Worker = class {
      constructor() { worker = this; }
      postMessage(job) { jobs.push(job); }
    };
    const book = { id: "stale-worker-stats" };
    const text = "One two one two";
    const vocab = { "one two": { status: "learning" } };

    assert.equal(getCachedTextStats(book, text, vocab), null);
    assert.equal(jobs.length, 1);
    vocab["one two"].status = "ignored";
    assert.equal(getCachedTextStats(book, text, vocab), null);

    worker.onmessage({ data: { id: jobs[0].id, stats: { unique: 2, known: 0, learning: 4, ignored: 0, new: 0 } } });
    assert.equal(jobs.length, 2);
    worker.onmessage({ data: { id: jobs[1].id, stats: { unique: 2, known: 0, learning: 0, ignored: 4, new: 0 } } });

    assert.deepEqual(getCachedTextStats(book, text, vocab), {
      unique: 2, known: 0, learning: 0, ignored: 4, new: 0
    });
    assert.deepEqual(events, ["text-stats:loaded"]);
  });

  it("waits for the worker result instead of displaying a partial count", async () => {
    const events = [];
    window.dispatchEvent = (event) => events.push(event.type);
    const activeWorker = globalThis.Worker;
    activeWorker.prototype.postMessage = function postMessage(job) {
      queueMicrotask(() => this.onmessage({ data: { id: job.id, stats: getTextStats(job.text, job.vocab, job.lang, job.algorithm) } }));
    };
    const book = { id: "worker-stats" };
    const text = "One two one two";
    const vocab = { one: { status: "known" }, "one two": { status: "learning" } };

    assert.equal(getCachedTextStats(book, text, vocab), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(getCachedTextStats(book, text, vocab), {
      unique: 2, known: 0, learning: 4, ignored: 0, new: 0
    });
    assert.deepEqual(events, ["text-stats:loaded"]);
  });
});
