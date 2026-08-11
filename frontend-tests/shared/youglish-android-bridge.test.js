// Contract tests for issue #140 point 1: on Android, opening the Youglish
// site must route through the native bridge (window.WordHunterAndroid.openUrl)
// BEFORE the youglishMode fallback — the internal popup is a silent no-op on
// Android and /__open_external returns HTTP 400 there, so reaching either
// means Youglish stays dead on Pocket.
// Pattern: frontend-tests/android/pocket-bridges.test.js.
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

// Installs the minimal browser globals the compiled youglish.js module needs
// at import time, plus a fetch recorder. The widget script element never
// loads; failScriptLoad() rejects loadYouglishApi() so the widget fallback
// (handleYouglishUnavailable -> openYouglishSite) runs synchronously.
function installYouglishHarness(openUrlImpl) {
  const fetches = [];
  const scripts = [];
  globalThis.window = {
    WordHunterAndroid: openUrlImpl ? { openUrl: openUrlImpl } : undefined,
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  globalThis.document = {
    addEventListener: () => {},
    getElementById: () => null,
    createElement: (tag) => {
      const script = {
        tagName: tag,
        dataset: {},
        remove: () => {},
        addEventListener: (type, handler) => {
          script._listeners = script._listeners || {};
          script._listeners[type] = handler;
        }
      };
      scripts.push(script);
      return script;
    },
    head: { appendChild: () => {} },
    querySelectorAll: () => []
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = (url) => {
    fetches.push(String(url));
    return Promise.reject(new Error("network disabled in test"));
  };
  return {
    fetches,
    failScriptLoad(index) {
      scripts[index]._listeners.error();
    }
  };
}

describe("Youglish Android bridge (issue #140 point 1)", () => {
  it("opens Youglish through the native bridge before the mode fallback (static order)", () => {
    const source = readFileSync(new URL("../../dist/web/js/youglish.js", import.meta.url), "utf8");
    assertSourceOrder(source, "openAndroidUrl(url)", 'mode === "external"');
  });

  it("routes the Youglish site through window.WordHunterAndroid.openUrl on Android", async () => {
    const bridgeCalls = [];
    const harness = installYouglishHarness((url) => {
      bridgeCalls.push(url);
      return true;
    });

    const { state } = await import("../../dist/web/js/state.js");
    const { openYouGlish } = await import("../../dist/web/js/youglish.js");
    state.preferences.learningLanguage = "de";
    state.preferences.youglishMode = "internal";

    openYouGlish("testword");
    harness.failScriptLoad(0);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(bridgeCalls, ["https://youglish.com/pronounce/testword/german"]);
    assert.deepEqual(harness.fetches, []);
  });

  it("keeps the desktop /__open_dict fallback when no Android bridge exists", async () => {
    const harness = installYouglishHarness(null);

    const { state } = await import("../../dist/web/js/state.js");
    const { openYouGlish } = await import("../../dist/web/js/youglish.js");
    state.preferences.learningLanguage = "de";
    state.preferences.youglishMode = "internal";

    openYouGlish("testword");
    harness.failScriptLoad(0);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.fetches.length, 1);
    assert.match(
      harness.fetches[0],
      /^\/__open_dict\?url=https%3A%2F%2Fyouglish\.com%2Fpronounce%2Ftestword%2Fgerman/
    );
    assert.ok(!harness.fetches[0].includes("/__open_external"));
  });
});
