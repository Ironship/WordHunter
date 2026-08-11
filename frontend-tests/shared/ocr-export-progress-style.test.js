import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression test for issue #117 / PR #148:
// the runtime creates TWO progress texts inside the shared `.ocr-progress-copy`
// wrapper — `#ocr-progress-text` (OCR/PDF import dialog, events/book-import.ts)
// and `#export-progress-text` (export overlay, sync-actions.ts). The emphasis
// style (ink color / bold / tight tracking) must keep applying to BOTH.
const css = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");

function cssRules(text) {
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const selector = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    rules.push({ selector, body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

const EMPHASIS_DECLARATIONS = ["color: var(--ink)", "font-weight: 700", "letter-spacing: -0.01em"];

function ruleForProgressText(id) {
  const wanted = `.ocr-progress-copy #${id}`;
  return cssRules(css).find((rule) =>
    rule.selector
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .includes(wanted),
  );
}

describe("OCR and export progress text emphasis style", () => {
  for (const id of ["ocr-progress-text", "export-progress-text"]) {
    it(`keeps the emphasis style on #${id} inside .ocr-progress-copy`, () => {
      const rule = ruleForProgressText(id);
      assert.ok(rule, `expected a rule selecting .ocr-progress-copy #${id}`);
      for (const declaration of EMPHASIS_DECLARATIONS) {
        assert.ok(
          rule.body.includes(declaration),
          `rule for .ocr-progress-copy #${id} must keep "${declaration}"`,
        );
      }
    });
  }
});
