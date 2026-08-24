import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  parseWordHunterWowSavedVariables,
  mergeWordHunterWowEntry
} = await import("../../dist/web/js/wow-addon-format.js");
const { isWordHunterWowReadyForKnown } = await import("../../dist/web/js/utils.js");
const importerSource = readFileSync(new URL("../../dist/web/js/wow-addon-import.js", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../../dist/web/js/events/word-editor.js", import.meta.url), "utf8");
const vocabListSource = readFileSync(new URL("../../dist/web/js/vocabulary/vocab-list.js", import.meta.url), "utf8");

describe("WordHunterWoW SavedVariables import", () => {
  it("decodes German words, meanings, notes, and quest context", () => {
    const source = 'WordHunterWoWDB = {}\nWordHunterWoWExport = "WHW2|Stra%C3%9Fe,learning,1787500000,1787500010,droga,Rzeczownik%20rodzaju%20%C5%BCe%C5%84skiego.,1787500005,Die%20Stra%C3%9Fe%20ist%20lang.,42,Ein%20langer%20Weg"\n';

    assert.deepEqual(parseWordHunterWowSavedVariables(source), [{
      word: "Straße",
      status: "learning",
      statusChangedAt: 1787500000,
      updatedAt: 1787500010,
      translation: "droga",
      note: "Rzeczownik rodzaju żeńskiego.",
      noteUpdatedAt: 1787500005,
      context: "Die Straße ist lang.",
      questId: "42",
      questTitle: "Ein langer Weg",
      firstSeenAt: 0,
      lastSeenAt: 0,
      encounterCount: 0
    }]);
  });

  it("reads WHW3 encounter dates and quest counts", () => {
    const source = 'WordHunterWoWExport = "WHW3|Wort,learning,1787500000,1787500010,word,Notiz,1787500005,Ein%20Satz,42,Titel,1786000000,1787500020,5"';

    assert.deepEqual(parseWordHunterWowSavedVariables(source)[0], {
      word: "Wort",
      status: "learning",
      statusChangedAt: 1787500000,
      updatedAt: 1787500010,
      translation: "word",
      note: "Notiz",
      noteUpdatedAt: 1787500005,
      context: "Ein Satz",
      questId: "42",
      questTitle: "Titel",
      firstSeenAt: 1786000000,
      lastSeenAt: 1787500020,
      encounterCount: 5
    });
  });

  it("keeps reading legacy WHW1 exports without notes", () => {
    const source = 'WordHunterWoWExport = "WHW1|Wort,new,1,2,slowo,Kontekst,7,Tytul"';

    assert.equal(parseWordHunterWowSavedVariables(source)[0].note, "");
    assert.equal(parseWordHunterWowSavedVariables(source)[0].noteUpdatedAt, 0);
  });

  it("accepts the numeric trailing metadata used by legacy WHW1 exports", () => {
    const source = 'WordHunterWoWExport = "WHW1|Wort,learning,1787500000,1787500010,slowo,Kontekst,26265,Tytul,2"';

    assert.equal(parseWordHunterWowSavedVariables(source)[0].word, "Wort");
    assert.throws(() => parseWordHunterWowSavedVariables(
      'WordHunterWoWExport = "WHW1|Wort,learning,1787500000,1787500010,slowo,Kontekst,26265,Tytul,not-a-number"'
    ));
  });

  it("rejects executable or malformed payloads instead of evaluating Lua", () => {
    assert.throws(() => parseWordHunterWowSavedVariables('WordHunterWoWExport = loadstring("bad")'));
    assert.throws(() => parseWordHunterWowSavedVariables('WordHunterWoWExport = "WHW1|Wort,broken,1,1,,,,"'));
  });

  it("shows busy and translation progress until the complete import finishes", () => {
    assert.match(importerSource, /beginElementBusy\(importLabel/);
    assert.match(importerSource, /transfer\.importingWow/);
    assert.match(importerSource, /transfer\.translatingWow/);
    assert.match(importerSource, /finally \{\s*finishProgress\(\)/);
  });

  it("shows encounter history in the editor and Known suggestions in the vocabulary list", () => {
    assert.match(editorSource, /add-word-history/);
    assert.match(editorSource, /vocab\.wowHistory/);
    assert.match(vocabListSource, /vocab\.readyForKnown/);
  });

  it("applies the WoW status and meaning to a word created by the import", () => {
    const entry = {
      status: "new",
      translation: "",
      updatedAt: "2026-08-24T14:00:00.000Z",
      nextDate: "2026-08-24"
    };
    const row = {
      word: "Straße",
      status: "learning",
      statusChangedAt: 1787500000,
      updatedAt: 1787500010,
      translation: "droga",
      note: "Rzeczownik rodzaju żeńskiego.",
      noteUpdatedAt: 1787500005,
      context: "",
      questId: "42",
      questTitle: "",
      firstSeenAt: 1786000000,
      lastSeenAt: 1787500020,
      encounterCount: 5
    };

    assert.equal(mergeWordHunterWowEntry(entry, row, false), true);
    assert.equal(entry.status, "learning");
    assert.equal(entry.translation, "droga");
    assert.equal(entry.note, "Rzeczownik rodzaju żeńskiego.");
    assert.equal(entry.statusUpdatedAt, "2026-08-23T15:46:40.000Z");
    assert.equal(entry.addedAt, "2026-08-06T07:06:40.000Z");
    assert.equal(entry.lastSeenAt, "2026-08-23T15:47:00.000Z");
    assert.equal(entry.encounterCount, 5);
    assert.equal(mergeWordHunterWowEntry(entry, row, true), false);
  });

  it("suggests Known only after five encounters and fourteen learning days", () => {
    const entry = {
      status: "learning",
      encounterCount: 5,
      learningStartedAt: "2026-08-01T00:00:00.000Z"
    };

    assert.equal(isWordHunterWowReadyForKnown(entry, Date.parse("2026-08-15T00:00:00.000Z")), true);
    assert.equal(isWordHunterWowReadyForKnown({ ...entry, encounterCount: 4 }, Date.parse("2026-08-15T00:00:00.000Z")), false);
    assert.equal(isWordHunterWowReadyForKnown({ ...entry, status: "known" }, Date.parse("2026-08-15T00:00:00.000Z")), false);
  });

  it("does not overwrite a newer Word Hunter status", () => {
    const entry = {
      status: "known",
      translation: "ulica",
      note: "Nowsza notatka w Word Hunterze",
      statusUpdatedAt: "2026-08-24T15:00:00.000Z",
      updatedAt: "2026-08-24T15:00:00.000Z"
    };
    const row = {
      word: "Straße",
      status: "learning",
      statusChangedAt: 1787500000,
      updatedAt: 1787500010,
      translation: "droga",
      note: "Notatka z WoW",
      noteUpdatedAt: 1787500005,
      context: "",
      questId: "42",
      questTitle: ""
    };

    mergeWordHunterWowEntry(entry, row, true);
    assert.equal(entry.status, "known");
    assert.equal(entry.translation, "ulica");
    assert.equal(entry.note, "Nowsza notatka w Word Hunterze");
    assert.equal(entry.updatedAt, "2026-08-24T15:00:00.000Z");
  });
});
