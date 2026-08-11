import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { initialLocale } = await import("../../dist/web/js/i18n.js");

describe("initialLocale (#135: Polish default locale)", () => {
  it("prefers the saved locale preference over the system locale", () => {
    assert.equal(initialLocale("de", "pl-PL"), "de");
    assert.equal(initialLocale("pl", "en-US"), "pl");
  });

  it("seeds the first-launch locale from navigator.language", () => {
    assert.equal(initialLocale(undefined, "de-DE"), "de");
    assert.equal(initialLocale(undefined, "en-US"), "en");
    assert.equal(initialLocale("", "fr-FR"), "fr");
  });

  it("falls back to Polish when the system locale is unknown or empty", () => {
    assert.equal(initialLocale(undefined, ""), "pl");
    assert.equal(initialLocale(undefined, undefined), "pl");
  });
});
