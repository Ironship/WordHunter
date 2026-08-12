import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads dist/web/js/state/autosave.js with recording api.js mocks. The
// harness drives the REAL mutation-tracking proxy: wrap(rawState), mutate
// through the proxy, then saveState() and inspect what the payload builder
// received.
async function loadAutosaveHarness() {
  const calls = {
    deltas: [],
    fulls: [],
    payloads: [],
  };
  const context = vm.createContext({
    window: { __qtBridge: true, __bridgeState: {}, dispatchEvent() {} },
    CustomEvent: class CustomEvent {},
    setTimeout: () => 1,
    clearTimeout() {},
    console,
  });
  const mocks = {
    "../api.js": {
      buildSavePayload: (state) => {
        const full = { full: true, state };
        calls.fulls.push(full);
        return full;
      },
      buildDeltaSavePayload: (raw, langs, texts) => {
        calls.deltas.push({ langs: [...langs], texts });
        return { delta: true, fullKeys: [], records: {} };
      },
      saveToLocalStorage() {},
      async saveWithRetry(payload) {
        calls.payloads.push(payload);
        return { ok: true };
      },
      saveSyncXhr() {},
      readPendingDelta() { return null; },
      clearPendingDelta() {}
    }
  };
  const modules = new Map();
  const load = async (specifier, parent = null) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (mocks[specifier]) {
      const names = Object.keys(mocks[specifier]);
      const module = new vm.SyntheticModule(names, function define() {
        for (const name of names) this.setExport(name, mocks[specifier][name]);
      }, { context, identifier: specifier });
      modules.set(specifier, module);
      await module.link(() => {});
      await module.evaluate();
      return module;
    }
    const url = new URL(specifier, parent ?? import.meta.url);
    assert.ok(url.pathname.includes("/dist/web/js/"), `unexpected dependency ${specifier}`);
    const source = await readFile(url, "utf8");
    const module = new vm.SourceTextModule(source, { context, identifier: String(url) });
    modules.set(specifier, module);
    await module.link((dependency) => load(dependency, url));
    await module.evaluate();
    return module;
  };
  const { createAutosave } = (await load("../../dist/web/js/state/autosave.js")).namespace;
  return { createAutosave, calls };
}

function makeRawState() {
  return {
    preferences: { learningLanguage: "en" },
    profiles: {
      en: { words: { w1: { status: "new" } } }
    },
    vocab: {},
    discover: { query: "" }
  };
}

describe("autosave dirty attribution (word status persistence, issue #127 P3)", () => {
  it("attributes a root state.vocab status mutation to the learning language", async () => {
    const { createAutosave, calls } = await loadAutosaveHarness();
    const raw = makeRawState();
    const autosave = createAutosave(() => raw);
    const state = autosave.wrap(raw);

    // Mutation through the ROOT vocab path with NO prior
    // state.profiles[lang].vocab traversal — the reported regression:
    // the status change existed only in RAM and vanished on restart.
    state.vocab.w1 = { status: "new" };
    state.vocab.w1.status = "learning";

    await autosave.saveState();

    assert.equal(calls.deltas.length, 1, "a delta save must run");
    assert.ok(calls.deltas[0].langs.includes("en"), "the learning language must be dirty");
  });

  it("still sends a delta (not a full snapshot) for profile-chain mutations", async () => {
    const { createAutosave, calls } = await loadAutosaveHarness();
    const raw = makeRawState();
    const autosave = createAutosave(() => raw);
    const state = autosave.wrap(raw);

    state.profiles.en.words.w1.status = "learning";

    await autosave.saveState();

    assert.equal(calls.deltas.length, 1);
    assert.equal(calls.fulls.length, 0, "an attributed mutation must keep using the delta path");
    assert.ok(calls.deltas[0].langs.includes("en"));
  });

  it("never sends an empty delta while a real mutation is pending", async () => {
    const { createAutosave, calls } = await loadAutosaveHarness();
    const raw = makeRawState();
    const autosave = createAutosave(() => raw);
    const state = autosave.wrap(raw);

    // An unattributed mutation (root-level, no vocab/texts/profile context):
    // the delta would be empty and the backend merge a no-op — the save must
    // fall back to a full snapshot instead.
    state.discover.query = "abc";

    await autosave.saveState();

    assert.equal(calls.deltas.length, 0, "an empty delta must not be sent for a pending mutation");
    assert.equal(calls.fulls.length, 1, "a full snapshot must cover the unattributed mutation");
  });

  it("falls back to a full snapshot again for a later unattributed mutation", async () => {
    const { createAutosave, calls } = await loadAutosaveHarness();
    const raw = makeRawState();
    const autosave = createAutosave(() => raw);
    const state = autosave.wrap(raw);

    state.profiles.en.words.w1.status = "known";
    await autosave.saveState();
    assert.equal(calls.deltas.length, 1);
    assert.equal(calls.fulls.length, 0);

    state.discover.query = "xyz";
    await autosave.saveState();
    assert.equal(calls.fulls.length, 1, "the second unattributed mutation must also be persisted");
  });
});
