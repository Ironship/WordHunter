import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { getCachedUniqueWordCount } = await import("../src/web/js/stats-cache.js");
const { requestVocabIndex } = await import("../src/web/js/vocab-index-client.js");

describe("cached unique word count", () => {
  it("reads the count without starting another vocabulary lookup", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return { ok: true, json: async () => ({ unique: 2, known: 1, learning: 0, ignored: 0, new: 1 }) };
    };
    const book = { id: "cached-book" };
    await requestVocabIndex({ book, text: "one two", vocab: {}, lang: "en", algorithm: "modern" });
    assert.equal(getCachedUniqueWordCount(book, "one two", "en", "modern"), 2);
    assert.equal(requests, 1);
  });
});
