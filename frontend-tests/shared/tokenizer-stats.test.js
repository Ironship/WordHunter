import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTokenOccurrences,
  findGermanSeparableVerbMatches,
  getSentenceForWord,
  getTextFromWordIndex,
  getTokenStats,
  normalizeVocabularyWord,
  tokenizeText
} from "../../dist/web/js/tokenizer_v2.js";

describe("token stats", () => {
  it("counts each token occurrence by vocabulary status", () => {
    const tokens = tokenizeText("Hello hello world", "en");
    assert.deepEqual(getTokenStats(tokens, { hello: { status: "known" } }), {
      unique: 2, known: 2, learning: 0, ignored: 0, new: 1
    });
  });

  it("uses longest non-overlapping phrases just like the Reader", () => {
    const tokens = tokenizeText("one two three", "en");
    const vocab = {
      "one two": { status: "learning" },
      "two three": { status: "known" }
    };
    const classifications = [...classifyTokenOccurrences(tokens, vocab, "en").values()];

    assert.deepEqual(classifications.map((entry) => entry.key), ["one two", "one two", "three"]);
    assert.deepEqual(getTokenStats(tokens, vocab, "en"), {
      unique: 3, known: 0, learning: 2, ignored: 0, new: 1
    });
  });

  it("does not match phrases across images or sentence boundaries", () => {
    const vocab = { "one two": { status: "known" } };
    assert.equal(getTokenStats(tokenizeText("one. two", "en"), vocab).known, 0);
    assert.equal(getTokenStats(tokenizeText("one [IMG:page.png] two", "en"), vocab).known, 0);
  });

  it("keeps Chinese text as selectable word tokens", () => {
    const words = tokenizeText("中文学习", "zh")
      .filter((part) => part.type === "word")
      .map((part) => part.value);

    assert.deepEqual(words, ["中文", "学习"]);
    assert.deepEqual(getTokenStats(tokenizeText("中文学习", "zh"), { 中文: { status: "known" } }), {
      unique: 2, known: 1, learning: 0, ignored: 0, new: 1
    });
  });

  it("treats attached French and Italian articles as metadata, not part of the vocabulary key", () => {
    const frenchVocab = { homme: { status: "known" } };
    for (const algorithm of ["classic", "modern"]) {
      const frenchTokens = tokenizeText("L'homme et l’homme.", "fr", algorithm);
      const frenchKeys = [...classifyTokenOccurrences(frenchTokens, frenchVocab, "fr").values()]
        .map((entry) => entry.key);

      assert.deepEqual(frenchKeys, ["homme", "et", "homme"], algorithm);
      assert.deepEqual(getTokenStats(frenchTokens, frenchVocab, "fr"), {
        unique: 2, known: 2, learning: 0, ignored: 0, new: 1
      }, algorithm);
    }
    assert.equal(getSentenceForWord("L’homme est ici.", "homme", "fr", "classic", 0), "L’homme est ici.");
    assert.equal(normalizeVocabularyWord("un’amica", "it"), "amica");
    assert.equal(normalizeVocabularyWord("d’homme", "fr"), "d'homme");
  });

  it("keeps legacy attached-article vocabulary keys readable", () => {
    const tokens = tokenizeText("L'homme et l’homme.", "fr", "classic");
    const classifications = [...classifyTokenOccurrences(tokens, {
      "l’homme": { status: "learning" }
    }, "fr").values()];

    assert.deepEqual(classifications.map((entry) => entry.key), ["l’homme", "et", "l’homme"]);
    assert.equal(classifications.filter((entry) => entry.status === "learning").length, 2);
  });

  it("returns context for the selected repeated word occurrence", () => {
    const text = "The first bank is closed. We sat by the river bank at noon.";

    assert.equal(
      getSentenceForWord(text, "bank", "en", "modern", 10),
      "We sat by the river bank at noon."
    );
    assert.equal(
      getSentenceForWord(text, "bank", "en", "modern", 2),
      "The first bank is closed."
    );
  });

  it("slices reading text from the exact repeated word occurrence", () => {
    const text = "First target is here. The second target is selected.";

    assert.equal(
      getTextFromWordIndex(text, 6, "en", "modern"),
      "target is selected."
    );
    assert.equal(getTextFromWordIndex(text, 99, "en", "modern"), null);
  });

  it("treats separated German verb parts as one vocabulary phrase", () => {
    const tokens = tokenizeText("Ich rufe dich an. Danach kommt er an.", "de");
    const vocab = { "rufe an": { status: "known" } };
    const matches = findGermanSeparableVerbMatches(tokens, vocab, "de");
    const matchedWords = [...matches.keys()].map((index) => tokens[index].value.toLowerCase());

    assert.deepEqual(matchedWords, ["rufe", "an"]);
    assert.deepEqual(getTokenStats(tokens, vocab, "de"), {
      unique: 7,
      known: 2,
      learning: 0,
      ignored: 0,
      new: 6
    });
  });

  it("does not join German verb parts across a clause boundary", () => {
    const tokens = tokenizeText("Ich rufe dich, danach kommt er an.", "de");
    assert.equal(findGermanSeparableVerbMatches(tokens, { "rufe an": { status: "known" } }, "de").size, 0);
  });

  it("recognizes multiple German separable verbs in one clause", () => {
    const tokens = tokenizeText("Ich rufe an und mache mit.", "de");
    const vocab = {
      "rufe an": { status: "known" },
      "mache mit": { status: "learning" }
    };
    assert.deepEqual(getTokenStats(tokens, vocab, "de"), {
      unique: 6, known: 2, learning: 2, ignored: 0, new: 2
    });
  });

  it("uses either clicked part of a separated German verb for sentence context", () => {
    const text = "Ich rufe dich an. Später rufe ich wieder an.";
    assert.equal(getSentenceForWord(text, "rufe an", "de", "modern", 1), "Ich rufe dich an.");
    assert.equal(getSentenceForWord(text, "rufe an", "de", "modern", 3), "Ich rufe dich an.");
    assert.equal(getSentenceForWord(text, "rufe an", "de", "modern", 5), "Später rufe ich wieder an.");
  });
});
