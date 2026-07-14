import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const documentListeners = new Map();
let closeToast;

globalThis.window = {
  WH_TOKEN: "test-token",
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  setTimeout,
  clearTimeout,
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.document = {
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  getElementById(id) {
    if (id !== "toast-close") return null;
    return {
      addEventListener(type, listener) {
        if (type === "click") closeToast = listener;
      },
    };
  },
};

const { els } = await import("../../dist/web/js/dom.js");
const { showToast } = await import("../../dist/web/js/toast.js");

describe("shared UI event behavior", () => {
  it("updates toast text without replacing its close control", () => {
    let visible = false;
    const toast = {
      classList: {
        add(name) { if (name === "visible") visible = true; },
        remove(name) { if (name === "visible") visible = false; },
      },
    };
    Object.defineProperty(toast, "textContent", {
      set() { throw new Error("replacing toast children removes the close button"); },
    });
    els.toast = toast;
    els.toastMessage = { textContent: "" };

    documentListeners.get("DOMContentLoaded")?.();
    showToast("Saved");

    assert.equal(els.toastMessage.textContent, "Saved");
    assert.equal(visible, true);
    assert.equal(typeof closeToast, "function");
    closeToast();
    assert.equal(visible, false);
  });

  it("imports an image after the file input change event", async () => {
    globalThis.FileReader = class {
      readAsDataURL(file) {
        assert.equal(file.name, "hint.png");
        this.onload({ target: { result: "data:image/png;base64,dGVzdA==" } });
      }
    };

    const { state } = await import("../../dist/web/js/state.js");
    const { handleGlobalChange } = await import("../../dist/web/js/events/global-actions.js");
    state.currentView = "library";
    delete state.vocab.example;
    const input = {
      files: [{ name: "hint.png" }],
      dataset: { uploadImage: "example" },
      value: "selected",
      closest(selector) { return selector === "[data-upload-image]" ? this : null; },
    };

    handleGlobalChange({ target: input });

    assert.equal(state.vocab.example.imageUrl, "data:image/png;base64,dGVzdA==");
    assert.equal(input.value, "");
  });

  it("requests Pocket vocabulary exports through the local backend", async () => {
    const originalFetch = globalThis.fetch;
    let request;
    window.WordHunterAndroid = {};
    delete window.__qtBridge;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ count: 1, content: "word" }) };
    };

    try {
      const { requestVocabExport } = await import("../../dist/web/js/sync-actions.js");
      const result = await requestVocabExport({ op: "export" });
      assert.equal(request.url, "/__vocab");
      assert.equal(request.options.method, "POST");
      assert.equal(request.options.headers["X-WH-Token"], "test-token");
      assert.deepEqual(result, { count: 1, content: "word" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports an already-flushed synchronization request without another save", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    window.__qtBridge = true;
    delete window.WordHunterAndroid;
    const { state } = await import("../../dist/web/js/state.js");
    state.syncDirectory = "/sync";
    globalThis.fetch = async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ snapshot: null }) };
    };

    try {
      const { syncNow } = await import("../../dist/web/js/events/settings.js");
      assert.equal(await syncNow({ background: true, saveFirst: false }), true);
      assert.deepEqual(requests, ["/__store/sync_now"]);
    } finally {
      globalThis.fetch = originalFetch;
      delete window.__qtBridge;
    }
  });

  it("does not apply a sync snapshot older than a local vocabulary change", async () => {
    const originalFetch = globalThis.fetch;
    window.__qtBridge = true;
    delete window.WordHunterAndroid;
    const {
      STATE_SCHEMA_VERSION,
      createDefaultState,
      replaceState,
      state
    } = await import("../../dist/web/js/state.js");
    const defaults = createDefaultState();
    const vocab = {
      haus: { status: "new", translation: "house", updatedAt: "2026-07-14T10:00:00.000Z" }
    };
    defaults.profiles.de.vocab = vocab;
    defaults.vocab = vocab;
    defaults.syncDirectory = "/sync";
    replaceState(defaults, { save: false });
    let resolveSync;
    globalThis.fetch = (url) => url === "/__store/ack_snapshot"
      ? Promise.resolve({ ok: true, json: async () => ({}) })
      : new Promise((resolve) => { resolveSync = resolve; });

    try {
      const { syncNow } = await import("../../dist/web/js/events/settings.js");
      const pendingSync = syncNow({ background: true, saveFirst: false });
      await Promise.resolve();
      state.vocab.haus.status = "known";
      state.vocab.haus.updatedAt = "2026-07-14T10:01:00.000Z";
      assert.equal(typeof resolveSync, "function");
      resolveSync({
        ok: true,
        json: async () => ({
          snapshot: {
            schemaVersion: STATE_SCHEMA_VERSION,
            prefs: { learningLanguage: "de" },
            texts: [],
            hiddenBooks: [],
            vocab: {
              de: {
                preferences: {},
                vocab: {
                  haus: { status: "new", translation: "house", updatedAt: "2026-07-14T10:00:00.000Z" }
                }
              }
            }
          }
        })
      });

      assert.equal(await pendingSync, true);
      assert.equal(state.vocab.haus.status, "known");
      assert.equal(state.vocab.haus.updatedAt, "2026-07-14T10:01:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
      delete window.__qtBridge;
    }
  });
});

after(() => {
  closeToast?.();
});
