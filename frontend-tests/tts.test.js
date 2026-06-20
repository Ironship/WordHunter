import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  getSelection: () => ({ isCollapsed: true, toString: () => "" })
};

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {}
};

const { splitTextForTts } = await import("../src/web/js/tts.js");

describe("TTS text splitting", () => {
  it("does not treat OCR line breaks as separate sentences", () => {
    assert.deepEqual(splitTextForTts("The\nquick\nbrown\nfox"), ["The quick brown fox"]);
  });

  it("joins wrapped OCR lines before sentence splitting", () => {
    assert.deepEqual(
      splitTextForTts("This sentence wraps\nacross a PDF line. Another sentence!"),
      ["This sentence wraps across a PDF line.", "Another sentence!"]
    );
  });

  it("removes hyphenation across OCR line breaks", () => {
    assert.deepEqual(splitTextForTts("A hyphen-\nated word."), ["A hyphenated word."]);
  });
});
