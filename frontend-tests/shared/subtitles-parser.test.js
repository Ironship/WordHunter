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

  it("decodes legacy files of other Central European and Cyrillic languages", () => {
    // "Příliš" in Windows-1250 and "Здравей" in Windows-1251.
    assert.equal(decodeImportedTextBytes(Uint8Array.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a]), "cs"), "Příliš");
    assert.equal(decodeImportedTextBytes(Uint8Array.from([0xc7, 0xe4, 0xf0, 0xe0, 0xe2, 0xe5, 0xe9]), "bg"), "Здравей");
    // Serbian subtitles are mostly Latin script: "Šta ćeš" in Windows-1250.
    assert.equal(decodeImportedTextBytes(Uint8Array.from([0x8a, 0x74, 0x61, 0x20, 0xe6, 0x65, 0x9a]), "sr"), "Šta ćeš");
  });

  it("keeps numeric dialogue in SRT and drops WebVTT cue identifiers", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nWhat year?\n\n2\n00:00:03,000 --> 00:00:04,000\n1984\n";
    assert.equal(parseImportedTextFile({ name: "film.srt" }, srt), "What year?\n1984");
    const vtt = "WEBVTT\n\nintro-cue\n00:00:01.000 --> 00:00:02.000\nHello\n\nc2\n00:00:03.000 --> 00:00:04.000\nWorld\n";
    assert.equal(parseImportedTextFile({ name: "film.vtt" }, vtt), "Hello\nWorld");
    // Some tools write the arrow without spaces.
    const tight = "1\n00:00:01,000-->00:00:02,000\n2024\n";
    assert.equal(parseImportedTextFile({ name: "film.srt" }, tight), "2024");
  });

  it("strips YouTube VTT metadata and zero-width markers", () => {
    const raw = "Kind: captions\nLanguage: de\nStyle:\n::cue(c.colorFEFEFE) { color: rgb(254,254,254);\n}\n##\n\u200B\u200B Khashchi\u200B\n\u200B— Hallo\u200B\n";
    assert.equal(parseImportedTextFile({ name: "youtube.vtt" }, raw), "Khashchi\n— Hallo");
  });
});
