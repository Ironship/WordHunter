import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { WH_TOKEN: "", dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.CustomEvent = class CustomEvent {};

const { state, switchLearningLanguage } = await import("../../dist/web/js/state.js");

describe("learning language switch", () => {
  it("fills missing profile collections before activating the profile", () => {
    state.preferences.learningLanguage = "pl";
    state.preferences.dictionaryUrl = "https://example.test/{{word}}";
    state.preferences.theme = "classic-dark";
    state.vocab = { dom: { status: "known" } };
    state.profiles = { pl: { vocab: state.vocab }, es: { preferences: { theme: "alternative-familiar" } } };

    switchLearningLanguage("es");

    assert.deepEqual(state.profiles.pl.vocab, { dom: { status: "known" } });
    assert.equal(state.profiles.pl.preferences.dictionaryUrl, "https://example.test/{{word}}");
    assert.equal(state.profiles.pl.preferences.theme, undefined);
    assert.equal(state.preferences.theme, "classic-dark");
    assert.deepEqual(state.vocab, {});
    assert.deepEqual(state.customTexts, []);
    assert.deepEqual(state.userBooks, []);
    assert.deepEqual(state.hiddenBuiltInBooks, []);
    assert.deepEqual(state.archivedBookIds, []);
  });

  it("keeps the Other profile translation pair separate from named profiles", () => {
    state.preferences.learningLanguage = "other";
    state.preferences.translationSourceLanguage = "nl";
    state.preferences.translationTargetLanguage = "pl";
    state.profiles = {
      other: { vocab: {}, preferences: {} },
      de: { vocab: {}, preferences: {} }
    };

    switchLearningLanguage("de");
    assert.equal(state.profiles.other.preferences.translationSourceLanguage, "nl");
    assert.equal(state.profiles.other.preferences.translationTargetLanguage, "pl");
    assert.equal(state.preferences.translationSourceLanguage, "");

    switchLearningLanguage("other");
    assert.equal(state.preferences.translationSourceLanguage, "nl");
    assert.equal(state.preferences.translationTargetLanguage, "pl");
  });
});
