import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTokenStats, tokenizeText } from "../../src/web/js/tokenizer_v2.js";

describe("token stats", () => {
  it("counts each token occurrence by vocabulary status", () => {
    const tokens = tokenizeText("Hello hello world", "en");
    assert.deepEqual(getTokenStats(tokens, { hello: { status: "known" } }), {
      unique: 2, known: 2, learning: 0, ignored: 0, new: 1
    });
  });

  it("keeps Chinese text as selectable word tokens", () => {
    const words = tokenizeText("中文学习", "zh")
      .filter((part) => part.type === "word")
      .map((part) => part.value);

    assert.ok(words.length >= 1);
    assert.equal(words.join(""), "中文学习");
  });
});
