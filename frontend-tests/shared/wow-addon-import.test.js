import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseWordHunterWowSavedVariables, mergeWordHunterWowEntry } = await import("../../dist/web/js/wow-addon-format.js");

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
      questTitle: "Ein langer Weg"
    }]);
  });

  it("keeps reading legacy WHW1 exports without notes", () => {
    const source = 'WordHunterWoWExport = "WHW1|Wort,new,1,2,slowo,Kontekst,7,Tytul"';

    assert.equal(parseWordHunterWowSavedVariables(source)[0].note, "");
    assert.equal(parseWordHunterWowSavedVariables(source)[0].noteUpdatedAt, 0);
  });

  it("rejects executable or malformed payloads instead of evaluating Lua", () => {
    assert.throws(() => parseWordHunterWowSavedVariables('WordHunterWoWExport = loadstring("bad")'));
    assert.throws(() => parseWordHunterWowSavedVariables('WordHunterWoWExport = "WHW1|Wort,broken,1,1,,,,"'));
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
      questTitle: ""
    };

    assert.equal(mergeWordHunterWowEntry(entry, row, false), true);
    assert.equal(entry.status, "learning");
    assert.equal(entry.translation, "droga");
    assert.equal(entry.note, "Rzeczownik rodzaju żeńskiego.");
    assert.equal(entry.statusUpdatedAt, "2026-08-23T15:46:40.000Z");
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
