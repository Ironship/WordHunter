import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("Android Pocket navigation", () => {
  it("keeps language controls available outside the hidden desktop sidebar", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    assert.match(html, /id="pref-locale-settings"/);
    assert.match(html, /id="pref-learning-language-settings"/);
    assert.match(html, /id="language-onboarding-dialog"/);
    assert.match(html, /id="pref-locale-onboarding"/);
    assert.match(html, /data-language-flag="learning"/);
  });

  it("keeps Project Gutenberg discover visible in Pocket navigation", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    assert.match(html, /data-view="discover"/);
    assert.match(html, /id="discover-view"/);
    assert.match(html, /option value="gutenberg"/);
    assert.equal(css.includes('.nav-item[data-view="discover"]'), false);
    assert.match(css, /grid-template-columns:\s*repeat\(7,/);
  });

  it("keeps Help reachable from Pocket settings", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../src/web/platforms/android-pocket.css", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const navigation = readFileSync(new URL("../../src/web/js/events/navigation.js", import.meta.url), "utf8");
    assert.match(html, /class="setting-row pocket-only-setting"[\s\S]*data-open-view="help"/);
    assert.match(styles, /\.pocket-only-setting\s*{\s*display: none;/);
    assert.match(css, /\.pocket-mode \.pocket-only-setting\s*{\s*display: grid;/);
    assert.match(css, /\.pocket-mode \.nav-item\[data-view="help"\]\s*{\s*display: none;/);
    assert.match(navigation, /\[data-open-view\]/);
  });

  it("submits Project Gutenberg search from the Android keyboard action", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const discoverEvents = readFileSync(new URL("../../src/web/js/events/discover.js", import.meta.url), "utf8");
    assert.match(html, /id="discover-query"[^>]*enterkeyhint="search"/);
    assert.match(discoverEvents, /discoverQuery\.addEventListener\("keydown"/);
    assert.match(discoverEvents, /event\.key !== "Enter"/);
    assert.match(discoverEvents, /els\.discoverQuery\.blur\(\)/);
  });

  it("does not block Pocket startup on remote font loading", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    assert.match(html, /rel="preload" as="style" href="https:\/\/fonts\.googleapis\.com/);
    assert.doesNotMatch(html, /href="https:\/\/fonts\.googleapis\.com[^"]+" rel="stylesheet"/);
  });

  it("wires the topbar reload button", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const navigation = readFileSync(new URL("../../src/web/js/events/navigation.js", import.meta.url), "utf8");
    assert.match(html, /id="app-reload"/);
    assert.match(navigation, /getElementById\("app-reload"\).*location\.reload/s);
  });

  it("ships Pocket language onboarding copy in every locale", () => {
    for (const code of ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"]) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/web/i18n/${code}.json`, import.meta.url), "utf8"));
      assert.equal(typeof dict.onboarding.languageHeading, "string");
      assert.equal(typeof dict.onboarding.languageCopy, "string");
      assert.equal(typeof dict.onboarding.continue, "string");
    }
  });
});
