import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = {
  __qtBridge: false,
  addEventListener() {},
  dispatchEvent() {}
};
globalThis.document = {
  documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { createDefaultState, replaceState, state } = await import("../../dist/web/js/state.js");
const {
  articleOptionsForLanguage,
  getSmartSuggestion,
  renderSmartSuggestionHtml,
  supportsArticleLanguage
} = await import("../../dist/web/js/reader/smart-suggest.js");
const { formatHeadword } = await import("../../dist/web/js/vocabulary/article.js");

function setLanguage(language, vocab = {}) {
  const defaults = createDefaultState();
  const profile = { vocab, customTexts: [], userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [], preferences: {} };
  replaceState({
    ...defaults,
    preferences: { ...defaults.preferences, learningLanguage: language },
    profiles: { ...defaults.profiles, [language]: profile },
    vocab: profile.vocab
  }, { save: false });
}

describe("grammatical article suggestions", () => {
  beforeEach(() => setLanguage("de"));

  for (const [language, context, word, article] of [
    ["de", "Das Haus ist alt.", "haus", "das"],
    ["fr", "L’homme lit un livre.", "homme", "l'"],
    ["fr", "L'homme lit un livre.", "homme", "l'"],
    ["es", "La casa es grande.", "casa", "la"],
    ["it", "Gli amici arrivano.", "amici", "gli"],
    ["it", "Un’amica arriva.", "amica", "un'"]
  ]) {
    it(`detects ${article} for ${language}`, () => {
      setLanguage(language);
      assert.deepEqual(getSmartSuggestion(context, word), { kind: "article", article, word });
    });
  }

  it("offers the noun target when the user taps a spaced article", () => {
    assert.deepEqual(getSmartSuggestion("Das Haus ist alt.", "das"), {
      kind: "article",
      article: "das",
      word: "haus"
    });
  });

  it("does not store ambiguous inflected German forms as dictionary articles", () => {
    assert.equal(getSmartSuggestion("Dem Haus fehlt ein Dach.", "haus"), null);
  });

  it("does not treat a French de contraction as an article", () => {
    setLanguage("fr");
    assert.equal(getSmartSuggestion("Il parle d’homme à homme.", "homme"), null);
  });

  it("does not overwrite an article that the user already saved", () => {
    setLanguage("de", { haus: { status: "learning", article: "die" } });
    assert.equal(getSmartSuggestion("Das Haus ist alt.", "haus"), null);
  });

  it("keeps German separable verbs as phrase suggestions", () => {
    const suggestion = getSmartSuggestion("Ich rufe dich morgen an.", "rufe");
    assert.deepEqual(suggestion, { kind: "separable-verb", word: "rufe an" });
    assert.match(renderSmartSuggestionHtml(suggestion), /data-suggest-word="rufe an"/);
    assert.doesNotMatch(renderSmartSuggestionHtml(suggestion), /data-suggest-article/);
  });

  it("renders article actions without merging article and word into one key", () => {
    const html = renderSmartSuggestionHtml({ kind: "article", article: "das", word: "haus" });
    assert.match(html, /data-suggest-article="das"/);
    assert.match(html, /data-suggest-word="haus"/);
    assert.doesNotMatch(html, /data-suggest-word="das haus"/);
  });

  it("exposes article controls only for supported languages", () => {
    assert.equal(supportsArticleLanguage("de-DE"), true);
    assert.equal(supportsArticleLanguage("pl"), false);
    assert.ok(articleOptionsForLanguage("it").includes("l'"));
  });

  it("keeps the manual article field visible in Reader and Add/Edit word", () => {
    const html = readFileSync(new URL("../../dist/web/index.html", import.meta.url), "utf8");
    const editor = readFileSync(new URL("../../dist/web/js/events/word-editor.js", import.meta.url), "utf8");
    const reader = readFileSync(new URL("../../dist/web/js/views/reader.js", import.meta.url), "utf8");

    assert.match(html, /id="add-article-input"[^>]*type="text"/);
    assert.match(html, /data-i18n="vocab\.addArticleLabel"/);
    assert.match(editor, /addArticleInput/);
    assert.match(editor, /delete entry\.article/);
    assert.match(reader, /data-suggest-article/);
    assert.match(reader, /updateWordField\([^,]+, "article",/);
  });

  it("formats spaced and apostrophe articles for display", () => {
    assert.equal(formatHeadword("Haus", "das"), "das Haus");
    assert.equal(formatHeadword("homme", "l'"), "l'homme");
    assert.equal(formatHeadword("amica", "un’"), "un’amica");
    assert.equal(formatHeadword("casa", ""), "casa");
    assert.equal(formatHeadword("l’homme", "l'"), "l’homme");
    assert.equal(formatHeadword("das Haus", "das"), "das Haus");
  });
});