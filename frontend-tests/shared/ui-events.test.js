import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const documentListeners = new Map();

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
  getElementById() { return null; },
  querySelector() { return null; },
  createElement() { return { setAttribute() {}, appendChild() {}, addEventListener() {} }; },
  body: { appendChild() {} },
};

const { showToast } = await import("../../dist/web/js/toast.js");

describe("shared UI event behavior", () => {
  it("updates toast text without replacing its close control", () => {
    let visible = false;
    const toast = {
      classList: {
        add(name) { if (name === "visible") visible = true; },
        remove(name) { if (name === "visible") visible = false; },
      },
      setAttribute() {},
    };
    Object.defineProperty(toast, "textContent", {
      set() { throw new Error("replacing toast children removes the close button"); },
    });
    const toastMessage = { textContent: "" };
    globalThis.document.getElementById = (id) => {
      if (id === "toast") return toast;
      if (id === "toast-message") return toastMessage;
      return null;
    };

    showToast("Saved");

    assert.equal(toastMessage.textContent, "Saved");
    assert.equal(visible, true);
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

  it("compresses oversized image uploads through a canvas before saving", async () => {
    const bigDataUrl = "data:image/png;base64," + "A".repeat(500 * 1024);
    globalThis.FileReader = class {
      readAsDataURL() { this.onload({ target: { result: bigDataUrl } }); }
    };
    const drawn = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext() { return { drawImage(image, x, y, w, h) { drawn.push([image, x, y, w, h]); } }; },
      toDataURL() { return "data:image/jpeg;base64,COMPRESSED"; }
    };
    const originalCreateElement = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => (tag === "canvas" ? canvas : originalCreateElement(tag));
    const OriginalImage = globalThis.Image;
    globalThis.Image = class {
      constructor() { this.naturalWidth = 4000; this.naturalHeight = 3000; this.width = 4000; this.height = 3000; }
      set src(value) { assert.equal(value, bigDataUrl); queueMicrotask(() => this.onload()); }
    };

    try {
      const { state } = await import("../../dist/web/js/state.js");
      const { handleGlobalChange } = await import("../../dist/web/js/events/global-actions.js");
      state.currentView = "library";
      delete state.vocab.example;
      const input = {
        files: [{ name: "big-photo.jpg" }],
        dataset: { uploadImage: "example" },
        value: "selected",
        closest(selector) { return selector === "[data-upload-image]" ? this : null; },
      };

      handleGlobalChange({ target: input });
      await new Promise((resolve) => setTimeout(resolve, 5));

      assert.equal(state.vocab.example.imageUrl, "data:image/jpeg;base64,COMPRESSED");
      // Downscaled to the 1024 px budget (4000 × 0.256) and drawn as JPEG.
      assert.equal(canvas.width, 1024);
      assert.equal(canvas.height, 768);
      assert.equal(drawn.length, 1);
      assert.equal(input.value, "");
    } finally {
      globalThis.document.createElement = originalCreateElement;
      globalThis.Image = OriginalImage;
    }
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

});

after(() => {
  documentListeners.clear();
});
