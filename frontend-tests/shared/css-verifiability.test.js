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
const TS_STYLE_PROP_PIN = 65;

/* T3: z-index declarations must reference the named --z-* scale; bare numerics
   are allowed only from the small legacy whitelist. */
const Z_INDEX_WHITELIST = new Set(["0", "1", "2", "3", "4", "5", "10", "50", "100", "1000"]);

/* T4: identical-declaration groups (>=2 rules sharing one declaration block)
   budget — baseline 48 (post-utility-sweep baseline; +1 from the #142
   pocket-only-control rules, 2026-08). */
const DUP_GROUP_PIN = 48;

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
