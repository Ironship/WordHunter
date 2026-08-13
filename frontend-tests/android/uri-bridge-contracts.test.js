// Contract tests for the 2026-08-13 Android audit fixes (P1/P2):
// - the Gutenberg card link in the library and the reader source link must
//   route through the native bridge (window.WordHunterAndroid.openUrl)
//   BEFORE the /__open_external fallback — the Android webview cannot open
//   new windows, and a skipped bridge means a dead link or a false
//   "openExternalFailed" toast;
// - the review-card TTS buttons must be 44 px touch targets on Pocket
//   (round-icon-btn-28/24 are 24-28 px wide in the shared stylesheet).
// Pattern: frontend-tests/shared/youglish-android-bridge.test.js.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function assertSourceOrder(source, before, after, message) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `Missing source marker: ${before}`);
  assert.notEqual(afterIndex, -1, `Missing source marker: ${after}`);
  assert.ok(beforeIndex < afterIndex, message || `Expected ${before} before ${after}`);
}

describe("Android URI bridge contracts", () => {
  it("routes the Gutenberg card link through the native bridge before the server fallback", () => {
    const library = readFileSync(
      new URL("../../dist/web/js/views/library.js", import.meta.url),
      "utf8"
    );
    // The link is picked up by the card delegation handler.
    assert.ok(
      library.includes('data-action="open-source"'),
      "library card link must carry data-action=open-source"
    );
    // The handler tries the bridge first, then /__open_external.
    assertSourceOrder(
      library,
      "openAndroidUrl(url))",
      'fetch(`/__open_external?url=',
      "bridge must run before the /__open_external fallback"
    );
  });

  it("routes the reader source link through the native bridge before the server fallback", () => {
    const renderer = readFileSync(
      new URL("../../dist/web/js/reader/renderer.js", import.meta.url),
      "utf8"
    );
    assertSourceOrder(
      renderer,
      "openAndroidUrl(url))",
      'fetch(`/__open_external?url=',
      "bridge must run before the /__open_external fallback"
    );
  });

  it("sizes the review-card TTS buttons to 44 px touch targets on Pocket", () => {
    const css = readFileSync(
      new URL("../../dist/web/platforms/android-pocket.css", import.meta.url),
      "utf8"
    );
    const start = css.indexOf(".pocket-mode .round-icon-btn-28");
    assert.notEqual(start, -1, "pocket rule for round-icon-btn must exist");
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    for (const expected of ["width: 44px", "min-width: 44px", "height: 44px"]) {
      assert.ok(rule.includes(expected), `rule must set ${expected}: ${rule}`);
    }
    assert.ok(rule.includes(".pocket-mode .round-icon-btn-24"), "rule must cover the 24 px variant too");
  });
});
