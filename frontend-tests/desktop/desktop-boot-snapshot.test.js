// Issue #281: desktop must start from the user's stored state. The Rust side
// inlines the store snapshot into the bootstrap script, so the renderer never
// shows the default preferences (English UI > German, empty library) while
// /__store/load is still running.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const template = readFileSync(new URL("../../src-tauri/templates/bootstrap.js", import.meta.url), "utf8");
const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");

const snapshot = {
  schemaVersion: 2,
  prefs: { locale: "pl", learningLanguage: "de", theme: "classic-dark" },
  vocab: {
    de: { vocab: { haus: { status: "learning" } }, userBooks: [], hiddenBuiltInBooks: [], archivedBookIds: [], preferences: {} }
  },
  texts: [{ id: "de-custom-mein-text", lang: "de", title: "Mein Text" }]
};

function runBootstrap(snapshotJson) {
  const fetches = [];
  const window = { fetch(url) { fetches.push(url); return new Promise(() => {}); } };
  const script = template
    .replaceAll("__WH_TOKEN_JSON__", JSON.stringify("token"))
    .replaceAll("__WH_IMAGE_OCR_AVAILABLE__", "false")
    .replaceAll("__WH_SNAPSHOT_JSON__", snapshotJson);
  // The deferred branch arms a 120 s abort timer; never schedule it here.
  vm.runInNewContext(script, { window, AbortController, setTimeout: () => 0, clearTimeout() {}, Request: class {} });
  return { window, fetches };
}

describe("desktop boot snapshot (#281)", () => {
  it("inlines the store snapshot on desktop only", () => {
    const call = handlers.match(/let bootstrap = bootstrap_script\(([\s\S]*?)\);/)?.[1] || "";
    assert.match(call, /#\[cfg\(not\(target_os = "android"\)\)\]\s*Some\(&state\.store\.snapshot\(\)\)/);
    assert.match(call, /#\[cfg\(target_os = "android"\)\]\s*None/);
  });

  it("hands an inlined snapshot to the renderer without a store round trip", () => {
    const { window, fetches } = runBootstrap(JSON.stringify(snapshot));
    // The template runs in its own realm; compare structurally.
    assert.deepEqual(JSON.parse(JSON.stringify(window.__bridgeState)), snapshot);
    assert.equal(window.__bridgeStatePromise, undefined);
    assert.deepEqual(fetches, []);

    const deferred = runBootstrap("null");
    assert.equal(deferred.window.__bridgeState, undefined);
    assert.deepEqual(deferred.fetches, ["/__store/load"]);
  });

  it("builds the first state from the stored profile instead of defaults", async () => {
    const { window } = runBootstrap(JSON.stringify(snapshot));
    Object.assign(window, {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      matchMedia() { return { matches: false, addEventListener() {} }; }
    });
    globalThis.window = window;
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.document = { addEventListener() {}, getElementById() { return null; } };

    const { state } = await import("../../dist/web/js/state.js");
    const { initialLocale } = await import("../../dist/web/js/i18n.js");

    assert.equal(state.preferences.locale, "pl");
    assert.equal(state.preferences.learningLanguage, "de");
    assert.equal(state.preferences.theme, "classic-dark");
    assert.deepEqual(state.customTexts.map((text) => text.id), ["de-custom-mein-text"]);
    assert.equal(state.vocab.haus.status, "learning");
    assert.equal(initialLocale(state.preferences.locale, "en-US"), "pl");
  });
});
