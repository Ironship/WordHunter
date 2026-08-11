import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Issue #144 release hygiene (bullets 2, 5, 7) static contracts:
//  - B2: scripts/build.bat must pin the exact Android NDK version
//    (27.0.12077973) instead of picking the newest installed NDK when
//    NDK_HOME is unset, and must fail with an sdkmanager instruction when
//    that exact version is missing.
//  - B5: Play Store publication is a documented manual decision (no upload
//    automation), and every Pocket locale has Play listing metadata
//    (title/short_description/full_description) in fastlane/metadata/android.
//  - B7: README discloses that OCR for scanned/image-only PDFs is not
//    available in Pocket.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function functionRegion(source, signature) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(`function ${signature}`);
  assert.ok(start >= 0, `build.bat is missing function: ${signature}`);
  const end = normalized.indexOf("\n}\n", start);
  assert.ok(end > start, "build.bat structure changed — update the contract");
  return normalized.slice(start, end + 3);
}

// Play listing locales use the en-US fastlane convention; the Pocket UI
// locales come from src/web/i18n/<code>.json.
const PLAY_LOCALE_BY_I18N = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  ja: "ja-JP",
  pl: "pl-PL",
  ru: "ru-RU",
  uk: "uk-UA",
  zh: "zh-CN",
};

describe("issue #144 release hygiene (bullets 2, 5, 7)", () => {
  it("pins the Android NDK version in build.bat instead of picking the newest installed", () => {
    const ensureNdk = functionRegion(read("../../scripts/build.bat"), "Ensure-AndroidNdk");

    assert.match(ensureNdk, /27\.0\.12077973/, "Ensure-AndroidNdk must prefer the pinned NDK version");
    assert.doesNotMatch(
      ensureNdk,
      /Sort-Object Name -Descending/,
      "Ensure-AndroidNdk must not fall back to the newest installed NDK",
    );
    assert.doesNotMatch(
      ensureNdk,
      /Select-Object -First 1/,
      "Ensure-AndroidNdk must not pick an arbitrary installed NDK",
    );
    assert.match(ensureNdk, /sdkmanager/, "a missing pinned NDK must fail with an sdkmanager instruction");
  });

  it("documents the manual Play Store publication decision", () => {
    const docs = read("../../docs/release-validation.md");

    assert.match(docs, /Play Store publication is manual/, "the manual-upload decision must be stated");
    assert.match(docs, /build\.bat play/, "the signed-AAB recipe must be referenced");
    assert.match(docs, /Play Console/, "the upload destination must be named");
    assert.match(docs, /keystore/, "the keystore requirement must be documented");
    assert.match(docs, /fingerprint/, "the certificate fingerprint check must be documented");
  });

  it("provides Play listing metadata for every Pocket locale", () => {
    const i18nLocales = readdirSync(new URL("../../src/web/i18n/", import.meta.url))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));

    assert.ok(i18nLocales.length >= 10, `expected at least 10 Pocket locales, got: ${i18nLocales.join(", ")}`);
    for (const locale of i18nLocales) {
      const playLocale = PLAY_LOCALE_BY_I18N[locale];
      assert.ok(playLocale, `no fastlane Play locale mapping for i18n locale: ${locale}`);
      const metadataDir = new URL(`../../fastlane/metadata/android/${playLocale}/`, import.meta.url);
      for (const file of ["title.txt", "short_description.txt", "full_description.txt"]) {
        assert.ok(
          existsSync(new URL(file, metadataDir)),
          `missing Play listing file: fastlane/metadata/android/${playLocale}/${file}`,
        );
      }
    }
  });

  it("discloses that OCR for scanned PDFs is unavailable in Pocket", () => {
    const readme = read("../../README.md");

    assert.match(
      readme,
      /OCR for scanned\/image-only PDFs is not available in Pocket/,
      "README must disclose the Pocket OCR limitation",
    );
    assert.match(readme, /desktop version/, "README must point scanned-PDF users to the desktop import");
    assert.match(readme, /local OCR runtime/, "README must name the desktop local OCR runtime");
  });
});
