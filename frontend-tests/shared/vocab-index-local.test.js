// Chinese and Japanese are segmented by the reader with Intl.Segmenter's
// dictionary. The backend's Unicode word breaks split them into single
// characters, so their "words in this text" index is built from the reader's
// tokens instead.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __qtBridge: true, addEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const requests = [];
globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error("backend not reachable in this test"); };

const { buildLocalVocabIndex, requestVocabIndex, usesLocalVocabIndex } = await import("../../dist/web/js/vocab-index-client.js");
const { entryAppearsInText } = await import("../../dist/web/js/text-vocab.js");

const segmenterHasDictionary = (() => {
  try {
    const parts = [...new Intl.Segmenter("ja", { granularity: "word" }).segment("日本語を勉強しています")];
    return parts.some((part) => part.segment.length > 1 && /\p{Script=Han}/u.test(part.segment));
  } catch {
    return false;
  }
})();

describe("vocabulary index for languages without spaces", () => {
  it("is built locally for ja, zh, th and friends only", () => {
    assert.equal(usesLocalVocabIndex("ja"), true);
    assert.equal(usesLocalVocabIndex("zh-CN"), true);
    assert.equal(usesLocalVocabIndex("th"), true);
    assert.equal(usesLocalVocabIndex("de"), false);
  });

  it("keeps the reader's words, so a saved 日本語 is found in the text", { skip: !segmenterHasDictionary }, async () => {
    const vocab = { "日本語": { status: "learning" } };
    const index = buildLocalVocabIndex("私は日本語を勉強しています。", vocab, "ja", "modern");
    assert.ok(index.words.includes("日本語"), JSON.stringify(index.words));
    assert.ok(!index.words.includes("本"));
    assert.equal(index.learning, 1);

    const entry = await requestVocabIndex({ text: "私は日本語を勉強しています。", vocab, lang: "ja", algorithm: "modern", book: { id: "ja-book" } });
    assert.equal(requests.length, 0, "no backend request for Japanese");
    assert.equal(entryAppearsInText("日本語", { words: new Set(entry.words), tokenLine: entry.tokenLine }, "ja"), true);
  });

  it("lists saved phrases the way the backend does", () => {
    const index = buildLocalVocabIndex("big red dog. red", { "big red": { status: "known" } }, "zh", "modern");
    assert.equal(index.tokenLine, " big red ");
    assert.equal(buildLocalVocabIndex("dog", {}, "zh", "modern").tokenLine, "  ");
  });
});
