// Contract test for issue #116 / PR #191: frontend dead code & type hygiene.
// Locks in the audit verdict:
//  - dead ambient types stay removed while live profile types remain declared,
//  - internal-only helpers are not exported (AI_EFFORT_LEVELS, getSmartSuggestionHtml by PR #191),
//  - charts.ts exports only the test-imported API (CEFR internals unexported),
//  - the test-imported API surface named in the issue stays exported,
//  - WhDomCache declares every cached element explicitly (no `[key: string]` index signature),
//    so `els.anyTypo` is a compile error instead of silently yielding undefined.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("dead-code contract (#116)", () => {
  it("removed ambient type stays removed (WhResolvedTheme)", () => {
    const dts = read("types/wordhunter-browser.d.ts");
    assert.doesNotMatch(dts, /\bWhResolvedTheme\b/, "WhResolvedTheme must stay removed");
    // WhProfilePreferences is NOT dead: WhProfile.preferences is read (state/normalize.ts
    // normalizeProfile) and written (state/defaults.ts, normalize.ts) — keep it.
    assert.match(dts, /\binterface WhProfilePreferences\b/, "WhProfilePreferences is a live ambient type");
  });

  it("internal-only helpers are not exported (AI_EFFORT_LEVELS, getSmartSuggestionHtml)", () => {
    const ai = read("src/web/js/ai-explainer.ts");
    assert.doesNotMatch(ai, /^export\s+const\s+AI_EFFORT_LEVELS\b/m, "AI_EFFORT_LEVELS is internal-only");
    const ss = read("src/web/js/reader/smart-suggest.ts");
    assert.doesNotMatch(ss, /^export\s+function\s+getSmartSuggestionHtml\b/m, "getSmartSuggestionHtml is internal-only");
  });

  it("charts.ts re-exports only getCefrThresholds, not the CEFR internals", () => {
    const charts = read("src/web/js/graphs/charts.ts");
    // the test-imported API stays exported (vocab-progress.test.js imports these from dist)
    assert.match(charts, /^export\s+function\s+getCurrentLevel\b/m);
    assert.match(charts, /^export\s+function\s+formatVocabProgressDate\b/m);
    assert.match(charts, /^export\s+function\s+buildAddedOverTimeBins\b/m);
    assert.match(charts, /^export\s+function\s+buildKnownWordSeries\b/m);
    assert.match(charts, /^export\s+function\s+buildKnownLearningWordSeries\b/m);
    // the tail export block re-exports the non-exported helper only
    assert.match(charts, /export\s*\{\s*getCefrThresholds\s*\};/, "export block must be exactly { getCefrThresholds }");
  });

  it("keeps the test-imported API surface exported (audit verdict for #116)", () => {
    const keep = [
      ["src/web/js/loading.ts", "withElementBusy"],
      ["src/web/js/events/global-actions.ts", "handleGlobalChange"],
      ["src/web/js/stats-cache.ts", "getCachedUniqueWordCount"],
      ["src/web/js/books.ts", "loadAllBookTexts"],
      ["src/web/js/books.ts", "loadAllCustomTextContents"],
      ["src/web/js/reader/pdf-page-text.ts", "countEffectivePdfPageWords"],
      ["src/web/js/reader/pdf-ocr-renderer.ts", "mapPdfOverlayWordIndexes"],
      ["src/web/js/reader/smart-suggest.ts", "supportsArticleLanguage"],
      ["src/web/js/views/heatmap.ts", "renderContributionHeatmap"],
      ["src/web/js/views/heatmap.ts", "latestHeatmapScrollLeft"],
      ["src/web/js/views/heatmap.ts", "buildContributionMonthLabels"],
      ["src/web/js/vocab-index-client.ts", "VOCAB_INDEX_CACHE_VERSION"],
    ];
    for (const [file, sym] of keep) {
      const src = read(file);
      assert.match(
        src,
        new RegExp(`^export\\s+(?:const|let|var|type|interface|class|(?:async\\s+)?function)\\s+${sym}\\b`, "m"),
        `${file} must keep exporting ${sym} (the frontend test suite imports it from dist)`,
      );
    }
  });

  it("WhDomCache declares and initializes every accessed element explicitly", () => {
    const dts = read("types/wordhunter-browser.d.ts");
    const dom = read("src/web/js/dom.ts");
    const iface = dts.match(/interface WhDomCache \{([\s\S]*?)\n\}/);
    assert.ok(iface, "WhDomCache interface must exist");
    assert.doesNotMatch(iface[1], /\[key:\s*string\]/, "WhDomCache must not have an index signature");
    const declared = new Set([...iface[1].matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm)].map((m) => m[1]));
    const assigned = [...dom.matchAll(/els\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)].map((m) => m[1]);
    const missing = [...new Set(assigned)].filter((k) => !declared.has(k));
    assert.deepEqual(
      missing,
      [],
      `els keys assigned in dom.ts but not declared in WhDomCache: ${missing.join(", ")}`,
    );
    const accessed = new Set(
      sourceFiles(path.join(ROOT, "src/web/js")).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/\bels\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g)].map((match) => match[1]),
      ),
    );
    const uninitialized = [...accessed].filter((key) => !assigned.includes(key));
    assert.deepEqual(
      uninitialized,
      [],
      `els keys read by frontend code but not initialized in dom.ts: ${uninitialized.join(", ")}`,
    );
    assert.match(
      dom,
      /function byId[^\{]*\{\s*return document\.getElementById\(id\)/s,
      "the typed byId helper must call the DOM API rather than recurse",
    );
  });

  it("built charts.js exposes no CEFR internals either", () => {
    const distCharts = path.join(ROOT, "dist/web/js/graphs/charts.js");
    if (!existsSync(distCharts)) return; // dist not built; source-level checks above still apply
    const js = readFileSync(distCharts, "utf8");
    assert.doesNotMatch(js, /export\s*\{[^}]*getKnownWordCount/, "dist must not export getKnownWordCount");
    assert.doesNotMatch(js, /export\s*\{[^}]*CEFR_LEVELS/, "dist must not export CEFR_LEVELS");
    assert.doesNotMatch(js, /export\s*\{[^}]*CEFR_THRESHOLDS/, "dist must not export CEFR_THRESHOLDS");
  });
});

describe("dead backend surface contract (#114)", () => {
  it("sync-actions.ts no longer sends algorithm in the /__vocab export payload", () => {
    const sync = read("src/web/js/sync-actions.ts");
    assert.doesNotMatch(
      sync,
      /algorithm:\s*string;/,
      "VocabularyExportRequest must not declare algorithm (removed by #114)",
    );
    assert.doesNotMatch(
      sync,
      /algorithm:\s*state\.preferences/,
      "export payload construction must not set algorithm (removed by #114)",
    );
  });

  it("vocab-index-client.ts no longer sends book/schemaVersion in the /__text/vocab_index body", () => {
    const vi = read("src/web/js/vocab-index-client.ts");
    assert.doesNotMatch(
      vi,
      /STATE_SCHEMA_VERSION/,
      "the STATE_SCHEMA_VERSION import must stay removed (schemaVersion is not sent by #114)",
    );
    const bodyLine = vi.split("\n").find((line) => line.includes("JSON.stringify({"));
    assert.ok(bodyLine, "the vocab_index fetch body line must exist");
    assert.doesNotMatch(
      bodyLine,
      /\b(book|schemaVersion)\b/,
      "the vocab_index fetch body must not carry book or schemaVersion (removed by #114)",
    );
  });

  it("removed #114 backend routes are not referenced anywhere in src/web", () => {
    const removedRoutes = [
      "/__subtitles/parse",
      "/__text/tokenize",
      "/__update/parse",
      "/__srs/ensure",
      "/__store/data_dir",
      "/__store/recovery_status",
      "/__data",
    ];
    for (const route of removedRoutes) {
      for (const file of sourceFiles(path.join(ROOT, "src/web/js"))) {
        const source = readFileSync(file, "utf8");
        assert.ok(
          !source.includes(route),
          `${path.relative(ROOT, file)} must not reference removed route ${route}`,
        );
      }
    }
  });
});
