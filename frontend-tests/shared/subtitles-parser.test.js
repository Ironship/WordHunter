import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseImportedTextFile } = await import("../../src/web/js/subtitles.js");

describe("subtitle parser", () => {
  it("strips YouTube VTT metadata and zero-width markers", () => {
    const raw = "Kind: captions\nLanguage: de\nStyle:\n::cue(c.colorFEFEFE) { color: rgb(254,254,254);\n}\n##\n\u200B\u200B Khashchi\u200B\n\u200B— Hallo\u200B\n";
    assert.equal(parseImportedTextFile({ name: "youtube.vtt" }, raw), "Khashchi\n— Hallo");
  });
});
