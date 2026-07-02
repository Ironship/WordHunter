import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || { __qtBridge: false };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
globalThis.document = globalThis.document || { addEventListener: () => {}, getElementById: () => null };

const {
  DEFAULT_LM_STUDIO_ENDPOINT,
  isDesktopOnlyTranslationProvider,
  normalizeTranslationProvider,
  normalizeTranslatorTextPreference
} = await import("../../src/web/js/translator-preferences.js");
const { resolveTranslatorPair } = await import("../../src/web/js/views/translator.js");

describe("translator preferences helpers", () => {
  it("keeps existing provider fallback rules explicit", () => {
    assert.equal(normalizeTranslationProvider("deepl"), "deepl");
    assert.equal(normalizeTranslationProvider("lmstudio"), "lmstudio");
    assert.equal(normalizeTranslationProvider("bad-provider"), "google");
    assert.equal(isDesktopOnlyTranslationProvider("offline"), true);
    assert.equal(isDesktopOnlyTranslationProvider("lmstudio"), true);
    assert.equal(isDesktopOnlyTranslationProvider("deepl"), false);
  });

  it("trims translator text preferences and preserves the LM Studio endpoint default", () => {
    assert.equal(normalizeTranslatorTextPreference("deeplApiKey", "  secret  "), "secret");
    assert.equal(normalizeTranslatorTextPreference("lmStudioModel", "  local-model  "), "local-model");
    assert.equal(normalizeTranslatorTextPreference("lmStudioEndpoint", "  "), DEFAULT_LM_STUDIO_ENDPOINT);
    assert.equal(normalizeTranslatorTextPreference("lmStudioEndpoint", "  http://localhost:9999/v1  "), "http://localhost:9999/v1");
  });
});

describe("translator language pair helpers", () => {
  it("keeps explicit select values even when no offline models are installed", () => {
    const pair = resolveTranslatorPair({
      fromValue: "ja",
      toValue: "pl",
      learningLanguage: "de",
      locale: "en",
      allCodes: ["de", "en", "ja", "pl"]
    });

    assert.equal(pair.fromCode, "ja");
    assert.equal(pair.toCode, "pl");
    assert.deepEqual(pair.fromCodes, ["de", "en", "ja", "pl"]);
    assert.deepEqual(pair.toCodes, ["de", "en", "ja", "pl"]);
  });

  it("falls back to configured defaults only when select values are missing or invalid", () => {
    const pair = resolveTranslatorPair({
      fromValue: "",
      toValue: "missing",
      learningLanguage: "de",
      locale: "pl",
      allCodes: ["de", "en", "pl"]
    });

    assert.equal(pair.fromCode, "de");
    assert.equal(pair.toCode, "pl");
  });
});
