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
const syncthingRegressionKeys = [
  "syncthingStart",
  "syncthingStop",
  "syncthingPair",
  "syncthingShowQR",
  "syncthingNotConfigured",
  "syncthingStopped",
  "syncthingRunning",
  "syncthingPeers",
  "syncthingNoPeers",
  "syncthingStarted",
  "syncthingPaired",
  "syncthingError",
  "syncthingPairPrompt",
  "syncthingPairNamePrompt",
  "syncthingQRTitle",
  "syncthingQRHint",
  "syncthingQRClose",
  "syncWizStep1Title",
  "syncWizStep1Desc",
  "syncWizStep2Title",
  "syncWizStep2Desc",
  "syncWizStep3Title",
  "syncWizStep3Desc",
  "syncWizStep4Title",
  "syncWizStep4Desc",
  "syncWizAndroid1",
  "syncWizAndroid2",
  "syncWizAndroid3",
  "syncWizAndroid4",
  "syncWizAndroid5",
  "syncWizFinalActive",
  "syncWizFinalNoPeers"
].map((key) => `settings.${key}`);
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
    "sync",
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
  "settings.wordPanelItems.youglish",
  "settings.translationProviderDeepL",
  "settings.translationProviderLmStudio"
]);
const copiedEnglishRegressionKeys = [
  ...syncthingRegressionKeys,
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
    const missing = [...staticI18nKeys()].filter((key) => !enKeys.has(key)).sort();

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

  it("keeps dynamic translator popup labels in every locale", () => {
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
});
