import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../dist/web/styles.css", import.meta.url), "utf8");

function cssPercentVariable(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}:\\s*([\\d.]+)%`));
  assert.ok(match, `${name} should be defined as a percentage`);
  return Number(match[1]) / 100;
}

function markerHeightPx(tokenHeightPx) {
  return Math.min(Math.max(tokenHeightPx * 0.08, 1), 3);
}

function markerCenterRatio(tokenHeightPx, bottomRatio) {
  const height = markerHeightPx(tokenHeightPx);
  return (tokenHeightPx - tokenHeightPx * bottomRatio - height / 2) / tokenHeightPx;
}

describe("PDF OCR visual geometry", () => {
  it("keeps OCR status marks in the underline zone instead of through glyph middles", () => {
    const bottomRatio = cssPercentVariable("--pdf-ocr-mark-bottom");
    const tokenHeights = [12, 16, 24, 36, 48];
    const centers = tokenHeights.map((height) => markerCenterRatio(height, bottomRatio));

    assert.ok(bottomRatio <= 0.08, "larger bottom offsets push the mark up into the text");
    for (const center of centers) {
      assert.ok(center >= 0.86, `marker center should stay low in token box, got ${center.toFixed(3)}`);
      assert.ok(center <= 0.94, `marker center should not fall outside the word box, got ${center.toFixed(3)}`);
    }
  });
});
