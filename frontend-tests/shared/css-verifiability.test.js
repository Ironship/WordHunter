import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const CSS_FILES = [
  "src/web/styles.css",
  "src/web/platforms/android-pocket.css",
  "src/web/theme.css"
];
const HTML_FILES = [
  "src/web/index.html",
  "src/web/templates/translator-popup.html"
];

function tsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) out.push(child);
    }
  };
  walk("src/web/js");
  return out;
}

/* T2: TS inline styles may only be runtime-interpolated (`style="...${...}..."`).
   Static one-off values must live in the stylesheet as utility classes. */
const TS_STYLE_ATTR_PIN = 17;

/* T2: runtime element-style writes are allowed only for these layout/animation
   properties (values are computed at runtime — not representable as classes). */
const TS_STYLE_PROP_WHITELIST = new Set([
  "background", "colorScheme", "cursor", "display", "fontSize", "gap",
  "height", "justifyContent", "left", "margin", "marginTop", "maxWidth",
  "opacity", "padding", "pointerEvents", "position", "top", "width", "zoom"
]);
// 66: showChoiceDialog (rc.6) reuses the confirmation-dialog sizing pattern —
// two .style width/max-width writes like showConfirmDialog above it.
const TS_STYLE_PROP_PIN = 66;

/* T3: z-index declarations must reference the named --z-* scale; bare numerics
   are allowed only from the small legacy whitelist. */
const Z_INDEX_WHITELIST = new Set(["0", "1", "2", "3", "4", "5", "10", "50", "100", "1000"]);

/* T4: identical-declaration groups (>=2 rules sharing one declaration block)
   budget — baseline 48 (post-utility-sweep baseline; +1 from the #142
   pocket-only-control rules, 2026-08). FIX-C (exp/theme-deai-rc3): +1 — the
   graphs-ai-summary separator now shares the exact hairline (55%) declaration
   with .settings-grid > .panel + .panel by design (separator unification).
   UI audit (2026-08-21, exp/theme-deai-rc3): +2 — radius literal unification
   (3px/4px/5px -> --radius/--radius-control tokens) merged previously distinct
   declaration blocks into shared token groups; fewer distinct literals, more
   identical groups by design. */
const DUP_GROUP_PIN = 51;

/* T5: stylesheet size budget — pins the SOURCE file sizes (not dist/), which
   is what the #129 P3 audit measured. Pins = audit baseline + ~2% headroom.
   Last growth: Wave C (2026-08, non-sec visual/perf) — ignored-word dash
   (WCAG 1.4.1), empty-state CTAs, graph-card nth-child stagger + learning-lvl
   color classes in styles.css. android-pocket.css grew in #215; theme.css last
   changed in #173. The audit's "pocket-reader.css" (6371 B) is theme.css — no
   such file exists on main.
   De-AI wave (2026-08, exp/theme-deai-rc3, NOT merged): per-card ⋯ overflow
   menu CSS + borderless import/export surfaces + less-saturated card stats —
   approx +1.7 KB net across 5 UI touches; pins re-baselined to fit.
   De-AI wave 2 (2026-08, exp/theme-deai-rc3, NOT merged): one radius scale
   (--radius-control 3px controls / --radius 4px panels, tags chip-ified),
   Graphs/Discover/Settings de-cardified onto flat surfaces with hairline
   separators, compact .button-xs defined for the first time. ~+0.5 KB net
   (most changes folded into existing rules), pins re-baselined again.
   De-AI wave 2 continuation / FIX-C (2026-08, exp/theme-deai-rc3, NOT merged):
   graphs-ai-summary + settings details + discover-toolbar separators unified to
   hairline 55%, library import-panel flattened on desktop (borderless like the
   export surface), z-index scale comment expanded. +~0.5 KB net on styles.css.
   FIX-B (2026-08, exp/theme-deai-rc3, NOT merged): android-pocket.css — hardcoded
   8px radii -> var(--radius) (9 spots, panel 8->4px), red #tts-stop-text restored,
   familiar-light focus patch extended to nav drawer + pocket toggle. +~1.5 KB:
   token text is longer than the 3-char literals, plus the two added rules/comments.
   Pin re-baselined for android-pocket.css only (styles.css untouched by FIX-B).
   FIX-D3 (2026-08, exp/theme-deai-rc3): vocab-table responsiveness — Example
   column hidden below 1080px (display:none + .table-wrap .vocab-table min-width:0
   media block) so the pinned Actions cell is never overlapped; Actions cell
   widened 340->376px so all 7 x 44px action buttons fit without clipping. +~450 B
   on styles.css, pin re-baselined.
   UI audit (2026-08-21, exp/theme-deai-rc3): resizer :focus-visible outline
   (keyboard separators), <780px vocab Actions column yield (376->308px),
   button-height scale fixes (article-suggestion/smart-suggestion/image-action),
   flat .ocr-progress-card + gloss-free .review-word, radius literals -> tokens,
   toast above export overlay. +~270 B net, pin re-baselined. */
const CSS_SIZE_PIN = new Map([
  ["src/web/styles.css", 118500],
  // 35255 B: +.review-header-actions rules — flashcard shuffle/reverse chips
  // pinned to the header edge (rc.4 review fix: shuffle filled the view).
  ["src/web/platforms/android-pocket.css", 36000],
  ["src/web/theme.css", 6500]
]);

/* T6: var(--x, #hex) fallbacks are a conscious decision — exactly 5 in
   styles.css. Audit lines 853, 885, 887, 2777, 2827 (pre-#219/#220 base);
   now at 868, 900, 902, 2792, 2842. Adding a 6th fallback requires updating
   this pin and the #129 audit together.
   FIX-A (2026-08, exp/theme-deai-rc3): the two stale --accent fallbacks
   #4a6cf7 -> #4f7cff (theme.css --accent is #4f7cff), so only #4f7cff
   remains (now 3x: find-match bg/shadow + line 2917). Updating the pin.
   FIX-D5 (2026-08, exp/theme-deai-rc3): palette de-AI toning — classic
   --accent desaturated #4f7cff -> #3f6fb5, --accent-ink #315bd6 -> #2f54a3
   (3x accent + 1x accent-ink fallbacks updated to match theme.css). */
const VAR_HEX_FALLBACK_PIN = new Map([
  ["var(--accent, #3f6fb5)", 3],
  ["var(--accent-ink, #2f54a3)", 1],
  ["var(--bg, #0d1114)", 1]
]);

describe("T1 — stylelint gate pins", () => {
  const pkg = JSON.parse(read("package.json"));

  it("pins lint:css to zero warnings", () => {
    assert.match(pkg.scripts["lint:css"], /--max-warnings\s+0/,
      "lint:css must fail the build on any stylelint warning");
  });

  it("runs lint:css inside check:frontend", () => {
    assert.match(pkg.scripts["check:frontend"], /lint:css/,
      "check:frontend must invoke lint:css");
  });

  it("documents why the max-warnings pin lives in package.json", () => {
    // stylelint 16.x exposes maxWarnings only on the CLI and the JS API
    // (LinterOptions); the config-file schema has no maxWarnings key, so the
    // package.json script is the only place the gate can be pinned.
    const config = read("stylelint.config.mjs");
    assert.doesNotMatch(config, /\bmaxWarnings\b/,
      "stylelint config cannot pin maxWarnings (CLI/API only)");
  });
});

describe("T2 — inline style sweep", () => {
  it("sweeps static HTML free of style= attributes", () => {
    for (const file of HTML_FILES) {
      const text = read(file);
      const matches = [...text.matchAll(/style\s*=\s*(["'])([^"']*)\1/g)];
      assert.equal(matches.length, 0,
        `${file} still has ${matches.length} inline style attribute(s): ` +
        matches.slice(0, 5).map((m) => m[0]).join(" | "));
    }
  });

  it("keeps TS style= attributes strictly dynamic", () => {
    const offenders = [];
    let count = 0;
    for (const file of tsFiles()) {
      const text = read(file);
      for (const m of text.matchAll(/style\s*=\s*"([^"]*)"/g)) {
        count += 1;
        if (!m[1].includes("${")) {
          offenders.push(`${relative(ROOT, file)}: style="${m[1]}"`);
        }
      }
    }
    assert.equal(offenders.length, 0,
      `static TS inline styles (must become utility classes): ${offenders.join("; ")}`);
    assert.ok(count <= TS_STYLE_ATTR_PIN,
      `TS style= count ${count} exceeds pin ${TS_STYLE_ATTR_PIN}`);
  });

  it("keeps runtime .style.<prop> writes on the property whitelist", () => {
    const offenders = [];
    let count = 0;
    for (const file of tsFiles()) {
      const text = read(file);
      for (const m of text.matchAll(/\.style\.([A-Za-z]+)\s*=/g)) {
        count += 1;
        if (!TS_STYLE_PROP_WHITELIST.has(m[1])) {
          offenders.push(`${relative(ROOT, file)}: .style.${m[1]}`);
        }
      }
    }
    assert.equal(offenders.length, 0,
      `.style.<prop> writes outside the whitelist: ${offenders.join("; ")}`);
    assert.ok(count <= TS_STYLE_PROP_PIN,
      `.style.<prop> write count ${count} exceeds pin ${TS_STYLE_PROP_PIN}`);
  });

  it("keeps setProperty writes limited to CSS custom properties", () => {
    const offenders = [];
    for (const file of tsFiles()) {
      const text = read(file);
      for (const m of text.matchAll(/\.setProperty\(\s*(["'])([^"']+)\1/g)) {
        if (!m[2].startsWith("--")) {
          offenders.push(`${relative(ROOT, file)}: setProperty("${m[2]}")`);
        }
      }
    }
    assert.equal(offenders.length, 0,
      `non-custom-property setProperty writes: ${offenders.join("; ")}`);
  });
});

describe("T3 — z-index scale", () => {
  it("uses only named scale variables or whitelisted numerics", () => {
    for (const file of CSS_FILES) {
      const text = read(file);
      for (const m of text.matchAll(/z-index\s*:\s*([^;]+);/g)) {
        const value = m[1].trim();
        assert.ok(
          /^var\(--z-[a-z0-9-]+\)$/.test(value) || Z_INDEX_WHITELIST.has(value),
          `${file}: z-index: ${value} is outside the named scale/whitelist`
        );
      }
    }
  });

  it("defines every --z-* variable it references", () => {
    for (const file of CSS_FILES) {
      const text = read(file);
      const used = new Set(
        [...text.matchAll(/var\((--z-[a-z0-9-]+)\)/g)].map((m) => m[1])
      );
      const missing = [...used].filter((name) => !text.includes(`${name}:`));
      assert.deepEqual(missing, [],
        `${file} references undefined z-scale variables: ${missing.join(", ")}`);
    }
  });
});

describe("T4 — stylesheet duplication", () => {
  function cssRules(text) {
    /* Brace-walking parser: collects every rule (selector, normalized decls)
       at any nesting depth; @keyframes bodies are opaque. */
    const rules = [];
    const n = text.length;
    const skipComment = (i) => {
      const end = text.indexOf("*/", i + 2);
      return end === -1 ? n : end + 2;
    };
    const walk = (start, end) => {
      let i = start;
      while (i < end) {
        const c = text[i];
        if (c === "/" && text[i + 1] === "*") { i = skipComment(i); continue; }
        if (c === "}") { i += 1; continue; }
        if (c === "@") {
          const brace = text.indexOf("{", i);
          const semi = text.indexOf(";", i);
          if (semi !== -1 && (brace === -1 || semi < brace)) { i = semi + 1; continue; }
          if (brace === -1 || brace >= end) break;
          const head = text.slice(i + 1, brace);
          let depth = 1;
          let p = brace + 1;
          while (p < end && depth > 0) {
            if (text[p] === "{") depth += 1;
            else if (text[p] === "}") depth -= 1;
            else if (text[p] === "/" && text[p + 1] === "*") p = skipComment(p) - 1;
            p += 1;
          }
          if (!/keyframes/i.test(head)) walk(brace + 1, Math.min(p - 1, end));
          i = p;
          continue;
        }
        const brace = text.indexOf("{", i);
        if (brace === -1 || brace >= end) break;
        let depth = 1;
        let p = brace + 1;
        while (p < end && depth > 0) {
          if (text[p] === "{") depth += 1;
          else if (text[p] === "}") depth -= 1;
          else if (text[p] === "/" && text[p + 1] === "*") p = skipComment(p) - 1;
          p += 1;
        }
        const decls = text.slice(brace + 1, p - 1)
          .replace(/\s+/g, " ").trim().replace(/;?\s*$/, "");
        rules.push({ selector: text.slice(i, brace).trim(), decls });
        i = p;
      }
    };
    walk(0, n);
    return rules;
  }

  it("keeps @media preludes unique within each stylesheet", () => {
    for (const file of CSS_FILES) {
      const preludes = [...read(file).matchAll(/@media\s+([^{]+)\{/g)].map((m) => m[1].trim());
      const duplicates = preludes.filter((p, i) => preludes.indexOf(p) !== i);
      assert.deepEqual([...new Set(duplicates)], [],
        `${file} has duplicate @media preludes — merge the blocks: ${[...new Set(duplicates)].join(", ")}`);
    }
  });

  it("keeps identical-declaration groups within the pinned budget", () => {
    /* Groups are counted per stylesheet (a group = >=2 rules inside one file
       sharing an identical declaration block), matching the audit baseline
       37 + 8 = 45. */
    let groups = 0;
    let largest = 0;
    for (const file of CSS_FILES) {
      const byDecl = new Map();
      for (const rule of cssRules(read(file))) {
        if (!rule.decls) continue;
        if (!byDecl.has(rule.decls)) byDecl.set(rule.decls, []);
        byDecl.get(rule.decls).push(rule.selector);
      }
      for (const selectors of byDecl.values()) {
        if (selectors.length >= 2) {
          groups += 1;
          largest = Math.max(largest, selectors.length);
        }
      }
    }
    assert.ok(groups <= DUP_GROUP_PIN,
      `identical-declaration groups ${groups} exceed pin ${DUP_GROUP_PIN} (largest: ${largest} rules)`);
  });
});

describe("T5 — stylesheet size budget", () => {
  for (const [file, pin] of CSS_SIZE_PIN) {
    it(`keeps ${file} within the pinned size budget`, () => {
      const { size } = statSync(join(ROOT, file));
      assert.ok(size <= pin,
        `${file} is ${size} B — exceeds pin ${pin} B (audit baseline + ~2%); ` +
        `bump the pin deliberately after a reviewed, justified growth`);
    });
  }
});

describe("T6 — var() hex fallback budget", () => {
  it("keeps var(--x, #hex) fallbacks in styles.css at the pinned 5", () => {
    const found = [];
    read("src/web/styles.css").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g)) {
        found.push({ line: i + 1, expr: m[0] });
      }
    });
    const byExpr = new Map();
    for (const { expr } of found) byExpr.set(expr, (byExpr.get(expr) ?? 0) + 1);
    const actual = [...byExpr].sort((a, b) => a[0].localeCompare(b[0]));
    const pinned = [...VAR_HEX_FALLBACK_PIN].sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(actual, pinned,
      `var() hex fallback counts drifted — now ${found.length} at lines ` +
      `${found.map((f) => f.line).join(", ")} (${found.map((f) => f.expr).join(" | ")}); ` +
      `every new fallback is a conscious decision: update the pin and the #129 audit`);
  });
});
