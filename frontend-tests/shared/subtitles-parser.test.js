import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { decodeImportedTextBytes, parseImportedTextFile } = await import("../../dist/web/js/subtitles.js");

describe("subtitle parser", () => {
  it("decodes UTF BOMs and falls back to Windows-1250 for legacy text files", () => {
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 72, 101, 108, 108, 111])),
      "Hello"
    );
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([0xff, 0xfe, 90, 0, 97, 0, 124, 1])),
      "Zaż"
    );
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([0xfe, 0xff, 0, 90, 0, 97, 1, 124])),
      "Zaż"
    );
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([122, 97, 191, 243, 179, 230, 32, 103, 234, 156, 108, 185, 32, 106, 97, 159, 241])),
      "zażółć gęślą jaźń"
    );
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([99, 97, 102, 233]), "fr"),
      "café"
    );
    assert.equal(
      decodeImportedTextBytes(Uint8Array.from([207, 240, 232, 226, 229, 242]), "ru"),
      "Привет"
    );
  });

  it("strips YouTube VTT metadata and zero-width markers", () => {
    const raw = "Kind: captions\nLanguage: de\nStyle:\n::cue(c.colorFEFEFE) { color: rgb(254,254,254);\n}\n##\n\u200B\u200B Khashchi\u200B\n\u200B— Hallo\u200B\n";
    assert.equal(parseImportedTextFile({ name: "youtube.vtt" }, raw), "Khashchi\n— Hallo");
  });
});
