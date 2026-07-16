import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };

const { state } = await import("../../dist/web/js/state.js");
const { invalidateBookId } = await import("../../dist/web/js/vocab-index-client.js");
const { entryAppearsInText, loadTextVocabularyIndex } = await import("../../dist/web/js/text-vocab.js");

describe("text vocabulary cache", () => {
  it("matches legacy attached-article keys against canonical text indexes", () => {
    const textIndex = {
      text: { id: "fr", title: "French", text: "L’homme." },
      words: new Set(["homme"]),
      tokenLine: " homme "
    };
    assert.equal(entryAppearsInText("l’homme", textIndex, "fr"), true);
    assert.equal(entryAppearsInText("d’homme", textIndex, "fr"), false);
  });

  it("retries with a fresh index when the active request is invalidated", async () => {
    const responses = [];
    let requests = 0;
    state.preferences.learningLanguage = "en";
    state.preferences.wordDetectionAlgorithm = "modern";
    state.customTexts = [{ id: "retry-text-index", title: "Retry", text: "fresh words" }];
    state.userBooks = [];
    globalThis.fetch = () => {
      requests += 1;
      return new Promise((resolve) => responses.push(resolve));
    };

    const loading = loadTextVocabularyIndex("retry-text-index");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    invalidateBookId("retry-text-index");
    responses[0]({
      ok: true,
      json: async () => ({ unique: 1, known: 1, learning: 0, ignored: 0, new: 0, words: ["stale"] })
    });
    while (requests < 2) await new Promise((resolve) => setImmediate(resolve));
    responses[1]({
      ok: true,
      json: async () => ({ unique: 2, known: 0, learning: 0, ignored: 0, new: 2, words: ["fresh", "words"] })
    });

    const index = await loading;
    assert.deepEqual([...index.words], ["fresh", "words"]);
  });
});
