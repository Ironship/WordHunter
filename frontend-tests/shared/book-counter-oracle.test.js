import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getReaderSession } from "../../src/web/js/reader/session.js";
import { getTextStats, getTokenStats, tokenizeText } from "../../src/web/js/tokenizer_v2.js";

const CORE_TEXT = "Alpha alpha beta gamma delta epsilon. New York new york. well-known don't 42. [IMG:cover.png] alpha.";
const CORE_VOCAB = {
  alpha: { status: "known" },
  beta: { status: "learning" },
  gamma: { status: "ignored" },
  delta: { status: "new" },
  new: { status: "known" },
  york: { status: "ignored" },
  "new york": { status: "learning" },
  well: { status: "known" },
  known: { status: "ignored" },
  "well-known": { status: "known" },
  "don't": { status: "ignored" },
  42: { status: "learning" }
};

function total(stats) {
  return stats.known + stats.learning + stats.ignored + stats.new;
}

function assertCounters({ id, text, vocab, lang, algorithm, expected }) {
  const direct = getTextStats(text, vocab, lang, algorithm);
  const tokens = tokenizeText(text, lang, algorithm);
  const fromTokens = getTokenStats(tokens, vocab, lang);
  const session = getReaderSession({ id, text }, lang, algorithm);
  const { total: expectedTotal, ...expectedStats } = expected;

  assert.deepEqual(direct, expectedStats);
  assert.deepEqual(fromTokens, expectedStats);
  assert.equal(total(direct), expectedTotal);
  assert.equal(session.totalWords, expectedTotal);
  assert.ok(direct.unique <= expectedTotal);
}

describe("book counter correctness oracle", () => {
  it("preserves occurrence counts, every status, phrases and algorithm differences", () => {
    assertCounters({
      id: "counter-oracle-modern",
      text: CORE_TEXT,
      vocab: CORE_VOCAB,
      lang: "en",
      algorithm: "modern",
      expected: { total: 15, unique: 11, known: 4, learning: 6, ignored: 3, new: 2 }
    });
    assertCounters({
      id: "counter-oracle-classic",
      text: CORE_TEXT,
      vocab: CORE_VOCAB,
      lang: "en",
      algorithm: "classic",
      expected: { total: 14, unique: 10, known: 4, learning: 6, ignored: 2, new: 2 }
    });
  });

  it("preserves counters for a large repeated book", () => {
    const text = Array.from({ length: 1000 }, () => CORE_TEXT).join("\n");
    assertCounters({
      id: "counter-oracle-large-modern",
      text,
      vocab: CORE_VOCAB,
      lang: "en",
      algorithm: "modern",
      expected: { total: 15000, unique: 11, known: 4000, learning: 6000, ignored: 3000, new: 2000 }
    });
    assertCounters({
      id: "counter-oracle-large-classic",
      text,
      vocab: CORE_VOCAB,
      lang: "en",
      algorithm: "classic",
      expected: { total: 14000, unique: 10, known: 4000, learning: 6000, ignored: 2000, new: 2000 }
    });
  });

  it("preserves German separable-verb and clause-local status counts", () => {
    const text = "Ich rufe dich an. Danach kommt er an. Ich rufe heute wieder an.";
    const vocab = {
      "rufe an": { status: "known" },
      ich: { status: "ignored" },
      kommt: { status: "learning" }
    };
    const expected = { total: 13, unique: 9, known: 4, learning: 1, ignored: 2, new: 6 };

    assertCounters({ id: "counter-oracle-de-modern", text, vocab, lang: "de", algorithm: "modern", expected });
    assertCounters({ id: "counter-oracle-de-classic", text, vocab, lang: "de", algorithm: "classic", expected });
  });
});
