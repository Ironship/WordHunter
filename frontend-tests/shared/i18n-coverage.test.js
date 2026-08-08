import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const localeDir = path.join("dist", "web", "i18n");
const localeFiles = fs.readdirSync(localeDir).filter((name) => name.endsWith(".json")).sort();
const translatorPopupKeys = [
  "title",
  "sourceLabel",
  "targetLabel",
  "placeholder",
  "targetPlaceholder",
  "footer",
  "copyBtn",
  "copied"
];
const selectedWordPanelKeys = [
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
const helpShortcutRegressionKeys = [
  "help.readerTitle",
  ...[
    "library",
    "reader",
    "translator",
    "discover",
    "vocab",
    "flashcards",
    "graphs",
    "export",
    "settings",
    "help"
  ].map((key) => `help.navKeys.${key}`),
  "help.focusTitle",
  ...["prevNext", "line", "escape", "selectMultiple"].map((key) => `help.focusKeys.${key}`),
  "help.actionTitle",
  ...[
    "merge",
    "smartSuggest",
    "ttsWord",
    "ttsSentence",
    "dict",
    "youglish",
    "status",
    "editFields",
    "copyWord",
    "removeStatus"
  ].map((key) => `help.actionKeys.${key}`),
  "help.flashcardsTitle",
  ...[
    "flip",
    "prevNext",
    "score",
    "ttsWord",
    "ttsSentence",
    "dict",
    "youglish",
    "searchImage"
  ].map((key) => `help.flashcardsKeys.${key}`)
];
const copiedEnglishAllowlist = new Set([
  "help.navKeys.export",
  "settings.wordPanelItems.youglish",
  "settings.translationProviderDeepL",
  "settings.translationProviderLmStudio"
]);
const copiedEnglishRegressionKeys = [
  ...helpShortcutRegressionKeys,
  "reader.nextPageTitle",
  "reader.prevPageTitle",
  "editBook.deleteCover",
  "toast.themeFamiliar",
  "toast.themeAlternativeFamiliar",
  "toast.themeClassicAuto",
  "toast.themeClassicLight",
  "toast.themeClassicDark",
  "languages.en",
  "graphs.mature",
  "settings.wordPanelItems.copy",
  "settings.wordPanelItems.edit",
  "settings.wordPanelItems.remove",
  ...copiedEnglishAllowlist
];
const correctedGradeSemantics = {
  "de.json": [
    "1 — falsch, aber das Wort kommt mir bekannt vor",
    "2 — falsch, nach einem Hinweis erinnert",
    "3 — richtig, aber nur mit Mühe",
    "4 — richtig, mit kurzem Zögern",
    "5 — perfekt erinnert"
  ],
  "es.json": [
    "1 — incorrecto, pero parece familiar",
    "2 — incorrecto, recordado tras una pista",
    "3 — correcto, pero con dificultad",
    "4 — correcto, con una ligera vacilación",
    "5 — recuerdo perfecto"
  ],
  "fr.json": [
    "1 — incorrect, mais le mot semble familier",
    "2 — incorrect, rappel après un indice",
    "3 — correct, mais difficile",
    "4 — correct, avec une légère hésitation",
    "5 — rappel parfait"
  ],
  "it.json": [
    "1 — errato, ma la parola sembra familiare",
    "2 — errato, ricordato dopo un suggerimento",
    "3 — corretto, ma con difficoltà",
    "4 — corretto, con una leggera esitazione",
    "5 — ricordo perfetto"
  ],
  "ru.json": [
    "1 — неправильно, но слово кажется знакомым",
    "2 — неправильно, удалось вспомнить после подсказки",
    "3 — правильно, но с трудом",
    "4 — правильно, с небольшой задержкой",
    "5 — вспомнено идеально"
  ]
};

function flatten(value, prefix = "", out = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out[prefix] = String(value ?? "");
  }
  return out;
}

function placeholders(text) {
  return [...text.matchAll(/\{\{?([A-Za-z0-9_]+)\}?\}/g)].map((match) => match[1]).sort();
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && /\.(html|js)$/.test(entry.name) ? [full] : [];
  });
}

function isLineComment(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  return source.slice(lineStart, index).trimStart().startsWith("//");
}

function staticI18nKeys() {
  const keys = new Set();
  for (const file of walk(path.join("dist", "web"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) {
      if (!isLineComment(source, match.index)) keys.add(match[1]);
    }
    for (const match of source.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      if (isLineComment(source, match.index)) continue;
      for (const part of match[1].split(/[;,]/)) {
        const key = part.split("=").pop()?.trim();
        if (key) keys.add(key);
      }
    }
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
      if (!isLineComment(source, match.index)) keys.add(match[1]);
    }
  }
  return keys;
}

describe("i18n coverage", () => {
  it("keeps locale key sets and placeholders in sync", () => {
    const locales = new Map(localeFiles.map((file) => [
      file,
      flatten(JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8")))
    ]));
    const baseline = locales.get("en.json");
    const baselineKeys = Object.keys(baseline).sort();

    for (const [file, data] of locales) {
      const keys = Object.keys(data).sort();
      assert.deepEqual(keys.filter((key) => !(key in baseline)), [], `${file} has extra locale keys`);
      assert.deepEqual(baselineKeys.filter((key) => !(key in data)), [], `${file} is missing locale keys`);

      for (const key of baselineKeys) {
        assert.deepEqual(placeholders(data[key]), placeholders(baseline[key]), `${file} placeholder mismatch at ${key}`);
      }
    }
  });

  it("ships every static UI key used by markup and JavaScript", () => {
    const enKeys = new Set(Object.keys(flatten(JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")))));
    const allowed = new Set(["timeout"]);
    const missing = [...staticI18nKeys()].filter((key) => !enKeys.has(key) && !allowed.has(key)).sort();

    assert.deepEqual(missing, []);
  });

  it("does not ship copied English in corrected localization groups", () => {
    const baseline = flatten(JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")));

    for (const file of localeFiles.filter((name) => name !== "en.json")) {
      const data = flatten(JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8")));
      const copied = copiedEnglishRegressionKeys
        .filter((key) => !copiedEnglishAllowlist.has(key) && data[key] === baseline[key])
        .sort();

      assert.deepEqual(copied, [], `${file} has copied English in corrected localization groups`);
    }
  });

  // The standalone offline-translator popup labels are built natively in
  // Rust (offline_translator/translator/ui.rs translator_labels), not from
  // the i18n dictionaries — the translator.* i18n keys were removed as dead
  // (see #119). This guard is retired with them.
  it.skip("keeps dynamic translator popup labels in every locale", () => {
    for (const file of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8"));
      for (const key of translatorPopupKeys) {
        assert.equal(typeof data.translator?.[key], "string", `${file} missing translator.${key}`);
        assert.ok(data.translator[key].trim(), `${file} has empty translator.${key}`);
      }
    }
  });

  it("keeps dynamic selected-word panel labels in every locale", () => {
    for (const file of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8"));
      for (const key of selectedWordPanelKeys) {
        assert.equal(typeof data.settings?.wordPanelItems?.[key], "string", `${file} missing settings.wordPanelItems.${key}`);
        assert.ok(data.settings.wordPanelItems[key].trim(), `${file} has empty settings.wordPanelItems.${key}`);
      }
    }
  });

  it("keeps numbered in-text grades aligned with the five recall qualities", () => {
    for (const file of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8"));
      for (let grade = 1; grade <= 5; grade += 1) {
        assert.match(data.sm2[`grade${grade}`], new RegExp(`^${grade} [—–-] `), `${file} sm2.grade${grade}`);
      }
    }

    for (const [file, expected] of Object.entries(correctedGradeSemantics)) {
      const data = JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8"));
      assert.deepEqual(expected.map((_, index) => data.sm2[`grade${index + 1}`]), expected, file);
    }
  });
});
