import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  location: { search: "" },
  addEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false }; }
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; }
};

const { checkForUpdates, isNewer } = await import("../../dist/web/js/update-checker.js");

describe("stable update version ordering", () => {
  it("orders release candidates before the final release", () => {
    assert.equal(isNewer("1.0.5-rc.2", "1.0.5-rc.1"), true);
    assert.equal(isNewer("1.0.5", "1.0.5-rc.2"), true);
    assert.equal(isNewer("1.0.5-rc.1", "1.0.5"), false);
  });

  it("retains legacy numeric version ordering", () => {
    assert.equal(isNewer("1.0.5", "1.0.4"), true);
    assert.equal(isNewer("0.2.7.7", "0.2.7.6"), true);
    assert.equal(isNewer("1.0.4", "1.0.4"), false);
  });
});

describe("update dialog release link", () => {
  it("opens the releases page through the Android bridge instead of window.open", async () => {
    const openUrlCalls = [];
    const windowOpenCalls = [];
    const clickListeners = {};
    const dialog = { closed: false, showModal() { this.closed = false; }, close() { this.closed = true; } };
    const makeButton = (listeners) => ({
      cloneNode() { return this; },
      replaceWith() {},
      addEventListener(type, handler) { listeners[type] = handler; }
    });

    globalThis.window = {
      __qtBridge: false,
      location: { search: "?platform=android" },
      WordHunterAndroid: {
        openUrl(url) { openUrlCalls.push(url); return true; }
      },
      open(url, target) { windowOpenCalls.push({ url, target }); },
      addEventListener() {},
      dispatchEvent() {}
    };
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ latest: "9.9.9", current: "1.0.0" }) });
    globalThis.HTMLButtonElement = {
      [Symbol.hasInstance](value) { return value !== null && typeof value === "object"; }
    };
    globalThis.HTMLDialogElement = {
      [Symbol.hasInstance](value) { return value !== null && typeof value === "object"; }
    };
    globalThis.document = {
      addEventListener() {},
      getElementById(id) {
        if (id === "update-dialog") return dialog;
        if (id === "update-open") return makeButton(clickListeners);
        if (id === "update-message" || id === "update-title") return { textContent: "" };
        return makeButton({});
      }
    };

    await checkForUpdates({ manual: true });
    clickListeners.click();

    assert.deepEqual(openUrlCalls, ["https://github.com/Ironship/WordHunter/releases"]);
    assert.equal(windowOpenCalls.length, 0);
    assert.equal(dialog.closed, true);
  });
});
