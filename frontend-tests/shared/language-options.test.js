import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { APP_LOCALES, DISCOVER_LANGUAGES, LEARNING_LANGUAGES } = await import("../../src/web/js/constants.js");

const html = fs.readFileSync("src/web/index.html", "utf8");

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

  it("offers discover languages plus all-languages search", () => {
    assert.deepEqual(optionValues(selectBody("discover-language")), [...DISCOVER_LANGUAGES, ""]);
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
