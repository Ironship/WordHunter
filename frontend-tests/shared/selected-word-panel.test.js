import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const itemIds = [
  "status",
  "dictionary",
  "speech",
  "youglish",
  "suggestion",
  "translation",
  "note",
  "image",
  "context",
  "copy",
  "edit",
  "remove"
];

describe("selected-word panel", () => {
  it("ships accessible settings hooks and immediate-save behavior", () => {
    const html = read("dist/web/index.html");
    const dom = read("dist/web/js/dom.js");
    const preferences = read("dist/web/js/preferences.js");
    const settings = read("dist/web/js/events/settings.js");

    assert.match(html, /<ol id="pref-selected-word-panel-items"[^>]+aria-labelledby="word-panel-items-heading"[^>]+aria-describedby="word-panel-items-hint"/);
    assert.match(dom, /prefSelectedWordPanelItems = document\.getElementById\("pref-selected-word-panel-items"\)/);
    assert.match(preferences, /data-word-panel-item-visible/);
    assert.match(preferences, /data-word-panel-item-move/);
    assert.match(preferences, /index === 0 \? "disabled"/);
    assert.match(preferences, /index === items\.length - 1 \? "disabled"/);
    assert.match(settings, /state\.preferences\.selectedWordPanelItems = normalizeSelectedWordPanelItems\(items\)/);
    assert.match(settings, /window\.flushWordFieldSave\?\.\(\)/);
    assert.match(settings, /saveState\(\)[\s\S]*syncSettingsControls\(\)[\s\S]*renderWordPanel\(currentText\)/);
  });

  it("renders only configured visible items in order and coalesces actions", () => {
    const panel = read("dist/web/js/reader/word-panel.js");
    const constants = read("dist/web/js/constants.js");

    assert.match(panel, /for \(const item of normalizeSelectedWordPanelItems\(state\.preferences\.selectedWordPanelItems\)\)/);
    assert.match(panel, /if \(!item\.visible\)\s*continue/);
    assert.match(panel, /ACTION_ITEM_IDS\.has\(item\.id\)/);
    assert.match(panel, /parts\.push\(`<div class="word-actions">\$\{actionParts\.join\(""\)\}<\/div>`\)/);
    assert.match(panel, /if \(isTransientRange\)\s*return ""/);
    assert.match(panel, /data-copy-word/);
    assert.match(panel, /data-edit-word/);
    assert.doesNotMatch(panel, /pocket-word-dictionary/);
    assert.ok(constants.indexOf('{ id: "status", visible: true }') < constants.indexOf('{ id: "dictionary", visible: true }'));
    assert.ok(constants.indexOf('{ id: "dictionary", visible: true }') < constants.indexOf('{ id: "speech", visible: true }'));
    assert.ok(constants.indexOf('{ id: "speech", visible: true }') < constants.indexOf('{ id: "youglish", visible: true }'));
    assert.ok(constants.indexOf('{ id: "remove", visible: true }') < constants.indexOf('{ id: "suggestion", visible: true }'));
  });

  it("reuses the clipboard and edit handlers", () => {
    const actions = read("dist/web/js/events/global-actions.js");
    const editor = read("dist/web/js/events/word-editor.js");
    assert.match(actions, /copySelectedWordToClipboard/);
    assert.match(actions, /closest\("\[data-copy-word\]"\)/);
    assert.match(editor, /editing && state\.currentView === "reader"/);
    assert.match(editor, /import\("\.\.\/reader\/renderer\.js"\)\.then\(\(\{ renderReader \}\) => \{[\s\S]*state\.selectedWord === editing[\s\S]*renderReader\(\)/);
  });

  it("keeps every settings label localized in all nine locales", () => {
    const locales = ["en", "pl", "de", "es", "fr", "it", "ja", "ru", "uk"];
    const dictionaries = locales.map((locale) => [locale, JSON.parse(read(`dist/web/i18n/${locale}.json`))]);
    const required = [
      "wordPanelItemsHeading",
      "wordPanelItemsHint",
      "wordPanelItemVisible",
      "wordPanelMoveUp",
      "wordPanelMoveDown",
      "wordPanelMoveUpAria",
      "wordPanelMoveDownAria"
    ];
    for (const [locale, dictionary] of dictionaries) {
      for (const key of required) assert.ok(dictionary.settings[key]?.trim(), `${locale}.settings.${key}`);
      for (const id of itemIds) assert.ok(dictionary.settings.wordPanelItems[id]?.trim(), `${locale}.settings.wordPanelItems.${id}`);
    }
    const english = dictionaries[0][1].settings;
    for (const [locale, dictionary] of dictionaries.slice(1)) {
      assert.notEqual(dictionary.settings.wordPanelItemsHeading, english.wordPanelItemsHeading, `${locale} heading is untranslated`);
      assert.notEqual(dictionary.settings.wordPanelItemsHint, english.wordPanelItemsHint, `${locale} hint is untranslated`);
      assert.notEqual(dictionary.settings.wordPanelMoveUp, english.wordPanelMoveUp, `${locale} Up is untranslated`);
      assert.notEqual(dictionary.settings.wordPanelMoveDown, english.wordPanelMoveDown, `${locale} Down is untranslated`);
    }
  });
});
