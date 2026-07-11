import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { APP_LOCALES, LEARNING_LANGUAGES } = await import("../../src/web/js/constants.js");
const { normalizeState } = await import("../../src/web/js/state/normalize.js");

const html = fs.readFileSync("src/web/index.html", "utf8");
const discoverView = fs.readFileSync("src/web/js/views/discover.js", "utf8");
const discoverEvents = fs.readFileSync("src/web/js/events/discover.js", "utf8");
const defaults = fs.readFileSync("src/web/js/state/defaults.js", "utf8");

function selectBody(id) {
  const match = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?<\\/select>`));
  assert.ok(match, `missing select: ${id}`);
  return match[0];
}

function optionValues(selectHtml) {
  return [...selectHtml.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
}

describe("language selectors", () => {
  it("keeps app locale selectors limited to shipped locale files", () => {
    for (const id of ["pref-locale-sidebar", "pref-locale-settings", "pref-locale-onboarding"]) {
      assert.deepEqual(optionValues(selectBody(id)), APP_LOCALES);
    }
  });

  it("offers every learning profile in every learning-language selector", () => {
    for (const id of ["pref-learning-language-sidebar", "pref-learning-language-settings", "pref-learning-language-onboarding"]) {
      assert.deepEqual(optionValues(selectBody(id)), LEARNING_LANGUAGES);
    }
  });

  it("uses the active learning profile instead of a separate discover language selector", () => {
    assert.equal(html.includes('id="discover-language"'), false);
    assert.match(discoverView, /preferences\?\.learningLanguage/);
    assert.doesNotMatch(discoverView, /state\.discover\.language/);
    assert.doesNotMatch(discoverEvents, /discoverLanguage/);
    assert.doesNotMatch(defaults, /language: "de"/);
  });

  it("drops unknown discover fields from saved state", () => {
    const restored = normalizeState({
      discover: { query: "kobzar", language: "de", source: "gutenberg", page: 3 },
      preferences: { learningLanguage: "uk" }
    });

    assert.equal(Object.hasOwn(restored.discover, "language"), false);
    assert.equal(restored.discover.query, "kobzar");
    assert.equal(restored.preferences.learningLanguage, "uk");
  });

  it("localizes new learning-language labels in every locale file", () => {
    for (const file of fs.readdirSync("src/web/i18n").filter((name) => name.endsWith(".json"))) {
      const data = JSON.parse(fs.readFileSync(`src/web/i18n/${file}`, "utf8"));
      for (const code of ["zh", "la", "grc"]) {
        assert.equal(typeof data.languages?.[code], "string", `${file} missing languages.${code}`);
        assert.ok(data.languages[code].trim(), `${file} has empty languages.${code}`);
      }
      assert.equal(data.discover?.sourceWikisource, "Wikisource", `${file} missing discover.sourceWikisource`);
      assert.equal(data.library?.sourceWikisource, "Wikisource", `${file} missing library.sourceWikisource`);
    }
  });

  it("keeps Latin and Ancient Greek on the custom flag artwork", () => {
    const latinFlag = fs.readFileSync("src/web/flags/la.svg", "utf8");
    const greekFlag = fs.readFileSync("src/web/flags/grc.svg", "utf8");

    assert.match(latinFlag, /Flag_of_the_Roman_Empire_with_Eagle/);
    assert.match(greekFlag, /Owl_of_Athena/);
    assert.doesNotMatch(latinFlag, />SPQR</);
    assert.doesNotMatch(greekFlag, /<circle[^>]+cx="1\.5"[^>]+cy="1"/);
  });
});
