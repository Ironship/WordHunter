import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTokenStats, tokenizeText } from "../src/web/js/tokenizer_v2.js";

describe("token stats", () => {
  it("counts each token occurrence by vocabulary status", () => {
    const tokens = tokenizeText("Hello hello world", "en");
    assert.deepEqual(getTokenStats(tokens, { hello: { status: "known" } }), {
      unique: 2, known: 2, learning: 0, ignored: 0, new: 1
    });
  });
});
