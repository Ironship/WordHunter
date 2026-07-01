import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_LM_STUDIO_ENDPOINT,
  isDesktopOnlyTranslationProvider,
  normalizeTranslationProvider,
  normalizeTranslatorTextPreference
} = await import("../../src/web/js/translator-preferences.js");

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
