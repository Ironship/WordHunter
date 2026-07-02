import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { STATE_SCHEMA_VERSION } = await import("../../src/web/js/constants.js");
const { getCachedTextStats, getCachedUniqueWordCount } = await import("../../src/web/js/stats-cache.js");
const { computeSignature, requestVocabIndex } = await import("../../src/web/js/vocab-index-client.js");
const { getTextStats } = await import("../../src/web/js/tokenizer_v2.js");

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
    assert.match(computeSignature(book, "one two", "en", "modern"), new RegExp(`^vocab-index-v${STATE_SCHEMA_VERSION}\\|`));
  });

  it("keeps backend vocab index results when cache persistence hits quota", async () => {
    let writes = 0;
    globalThis.localStorage = {
      getItem() { return null; },
      setItem() {
        writes += 1;
        throw new Error("quota exceeded");
      }
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ unique: 1, known: 0, learning: 1, ignored: 0, new: 0, words: ["quota"] })
    });

    const result = await requestVocabIndex({
      book: { id: "quota-book" },
      text: "quota unique text",
      vocab: { quota: { status: "learning" } },
      lang: "en",
      algorithm: "modern"
    });
    await new Promise((resolve) => setTimeout(resolve, 320));

    assert.equal(result.stats.unique, 1);
    assert.ok(writes >= 1);
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

  it("waits for the worker result instead of displaying a partial count", async () => {
    const events = [];
    window.dispatchEvent = (event) => events.push(event.type);
    globalThis.Worker = class {
      postMessage(job) {
        queueMicrotask(() => this.onmessage({ data: { id: job.id, stats: getTextStats(job.text, job.vocab, job.lang, job.algorithm) } }));
      }
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
