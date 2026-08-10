import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { computeBuildInputHash } from "../../scripts/build-input-hash.mjs";

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
// Values byte-identical to English that are intentional and justified:
//  - brands and product names (Word Hunter, DeepL, LM Studio, YouGlish,
//    YouTube, Edge Neural TTS, CTranslate2, Gutenberg)
//  - sister-project source names in locales whose official localized name
//    keeps the English spelling (de/es/fr/it Wikisource, de/fr/pl Wikinews,
//    de/es/it/pl Wikipedia)
//  - keyboard key-cap tokens and shortcuts (Alt+? combos; Enter, Page Up and
//    Page Down where the standard local key caps are English-labeled — the
//    ru/uk/zh navigation cluster)
//  - technical tokens and format strings (~{size}MB, FSRS/SM-2 formulas,
//    numeric bin labels, ✓/✎/☆/†/>> glyphs, auto/manual, URLs)
//  - same-spelling loanwords that are correct in the target language
//    (Status de/pl, Export/Import/Navigation/Tags/Text/Cover/Normal/Minimal/
//    Maximum/Compact/Heatmap/Article/Image/Note/Source/Actions/Latin/Popular/
//    Color/rep/fragment/Version/Documentation/Model, fr "Page {page}")
const globallyIdenticalEnglishAllowlist = new Set([
  // Brands and product names.
  "app.title",
  "help.pocketEyebrow",
  "onboarding.languageEyebrow",
  "help.version",
  "discover.sourceGutenberg",
  "library.sourceGutenberg",
  "library.sourceGutenbergNoId",
  "reader.sourceGutenberg",
  "reader.sourceGutenbergTxt",
  "import.youtubeSource",
  "import.youtubeUrl",
  "settings.translationProviderDeepL",
  "settings.translationProviderLmStudio",
  "settings.translationProviderOffline",
  "settings.useEdgeTts",
  "settings.wordPanelItems.youglish",
  // Keyboard shortcuts.
  "nav.shortcut.discover",
  "nav.shortcut.export",
  "nav.shortcut.flashcards",
  "nav.shortcut.graphs",
  "nav.shortcut.help",
  "nav.shortcut.library",
  "nav.shortcut.reader",
  "nav.shortcut.settings",
  "nav.shortcut.translator",
  "nav.shortcut.vocabulary",
  "help.navKeys.export",
  // Technical tokens and format strings.
  "discover.died",
  "graphs.binEaseLabels",
  "graphs.binIntervalLabels",
  "graphs.binRepsLabels",
  "import.youtubeAutoTrack",
  "import.youtubeManualTrack",
  "library.cardStatPercent",
  "settings.argosDownloadSize",
  "settings.dictionaryUrlPlaceholder",
  "settings.readerWordPanelHideControl",
  "settings.srsAlgorithmFsrs",
  "topbar.known",
  "topbar.learning",
  "topbar.new",
  "translator.sizeMb",
  "vocab.fsrsMeta",
  "vocab.sm2Meta",
  "help.sm2Title"
]);
// Locale-specific spellings are pairs, not a global key exemption: a term
// that is legitimately identical in German must not hide copied English in
// Japanese or Chinese.
const localeSpecificIdenticalEnglishAllowlist = {
  "de.json": new Set(["app.navAriaLabel", "discover.sourceWikinews", "discover.sourceWikipedia", "discover.sourceWikisource", "editBook.tagsLabel", "import.heading", "import.tags", "import.text", "library.archiveFilter", "library.coverAlt", "library.sourceWikinews", "library.sourceWikipedia", "library.sourceWikisource", "nav.export", "reader.textLabel", "settings.aiEffortMinimal", "settings.lineNormal", "settings.reviewGraphHeatmap", "settings.wordPanelItems.status", "vocab.exportVisible", "vocab.status", "vocab.thStatus"]),
  "es.json": new Set(["discover.sortPopular", "discover.sourceWikipedia", "discover.sourceWikisource", "library.sourceWikipedia", "library.sourceWikisource", "reader.bookmarkColor", "settings.lineNormal", "vocab.repetitionsAbbr"]),
  "fr.json": new Set(["app.navAriaLabel", "discover.source", "discover.sourceWikinews", "discover.sourceWikisource", "editBook.tagsLabel", "help.tipsEyebrow", "languages.la", "library.fragment", "library.sourceWikinews", "library.sourceWikisource", "reader.articleLabel", "reader.bookmarkPage", "reader.bookmarkTabTitle", "reader.imageAlt", "reader.noteLabel", "reader.source", "settings.aiEffortMax", "settings.aiEffortMinimal", "settings.lineCompact", "settings.reviewGraphHeatmap", "settings.wordPanelItems.article", "settings.wordPanelItems.image", "settings.wordPanelItems.note", "vocab.exportVisible", "vocab.thActions"]),
  "it.json": new Set(["discover.sourceWikipedia", "discover.sourceWikisource", "library.sourceWikipedia", "library.sourceWikisource"]),
  "ja.json": new Set(["reader.keyEnter"]),
  "pl.json": new Set(["discover.sourceWikinews", "discover.sourceWikipedia", "import.heading", "library.archiveFilter", "library.fragment", "library.sourceWikinews", "library.sourceWikipedia", "reader.keyEnter", "settings.aiModel", "settings.wordPanelItems.status", "vocab.status", "vocab.thStatus"]),
  "ru.json": new Set(["reader.keyPageDown", "reader.keyPageUp"]),
  "uk.json": new Set(["reader.keyEnter", "reader.keyPageDown", "reader.keyPageUp"]),
  "zh.json": new Set(["reader.keyPageDown", "reader.keyPageUp"])
};
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

function decodeHtmlText(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

describe("i18n coverage", () => {
  it("fails direct runs when dist/web is stale relative to the frontend build stamp", async () => {
    const stampPath = path.join("dist", "web", ".wordhunter-build.sha256");
    const shipped = fs.readFileSync(stampPath, "utf8").trim();
    const expected = await computeBuildInputHash();

    assert.equal(
      shipped,
      expected,
      'dist/web is stale relative to src/web — run "npm run build:frontend" before direct test runs'
    );
  });

  it("keeps static English fallbacks aligned with en.json", () => {
    const html = fs.readFileSync(path.join("dist", "web", "index.html"), "utf8");
    const english = flatten(JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")));
    const mismatches = [];
    const languageFallbacks = new Map();

    for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bdata-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1>/gi)) {
      const [, , , key, fallback] = match;
      const decoded = decodeHtmlText(fallback);
      if (!decoded) continue;
      if (key.startsWith("languages.")) {
        const values = languageFallbacks.get(key) || new Set();
        values.add(decoded);
        languageFallbacks.set(key, values);
      } else if (key in english && decoded !== english[key].trim()) {
        mismatches.push(`${key}: ${JSON.stringify(decoded)} != ${JSON.stringify(english[key].trim())}`);
      }
    }

    for (const [key, values] of languageFallbacks) {
      if (values.size > 1) mismatches.push(`${key} has inconsistent native-name fallbacks: ${[...values].join(" | ")}`);
    }

    for (const match of html.matchAll(/<[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/gi)) {
      const tag = match[0];
      for (const mapping of match[1].split(/[;,]/)) {
        const [attribute, key] = mapping.split("=").map((part) => part.trim());
        const fallback = tag.match(new RegExp(`\\b${attribute}="([^"]*)"`, "i"))?.[1];
        if (fallback !== undefined && key in english && decodeHtmlText(fallback) !== english[key].trim()) {
          mismatches.push(`${attribute}=${key}: ${JSON.stringify(decodeHtmlText(fallback))} != ${JSON.stringify(english[key].trim())}`);
        }
      }
    }

    assert.deepEqual(mismatches, []);
    assert.deepEqual(
      Object.entries(english)
        .filter(([key, value]) => key !== "settings.ankiTsvHeader" && value !== value.trim())
        .map(([key]) => key),
      [],
      "English locale values must not contain accidental edge whitespace",
    );
  });

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

  it("does not ship copied English outside the justified allowlist", () => {
    const baseline = flatten(JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")));

    for (const file of localeFiles.filter((name) => name !== "en.json")) {
      const data = flatten(JSON.parse(fs.readFileSync(path.join(localeDir, file), "utf8")));
      const localeAllowlist = localeSpecificIdenticalEnglishAllowlist[file] ?? new Set();
      const copied = Object.keys(baseline)
        .filter((key) => !globallyIdenticalEnglishAllowlist.has(key) && !localeAllowlist.has(key) && data[key] === baseline[key])
        .sort();

      assert.deepEqual(copied, [], `${file} has copied English values outside the justified allowlist`);
      for (const key of localeAllowlist) {
        assert.equal(data[key], baseline[key], `${file}:${key} is a stale locale-specific English exemption`);
      }
    }
  });

  // The standalone offline-translator popup renders labels supplied by
  // translator_labels() (offline_translator/translator/ui.rs), which loads
  // the translator.* object from the shipped locale JSON at runtime. The
  // keys were restored in every locale after the dead-key sweep blanked the
  // popup (see #119); this guard keeps them present and non-empty so the
  // popup never silently falls back to its Polish defaults.
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
