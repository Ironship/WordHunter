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

const { isNewer } = await import("../../dist/web/js/update-checker.js");

describe("stable update version ordering", () => {
  it("orders release candidates before the final release", () => {
    assert.equal(isNewer("1.0.5-rc.2", "1.0.5-rc.1"), true);
    assert.equal(isNewer("1.0.5-rc.3", "1.0.5-rc.2"), true);
    assert.equal(isNewer("1.0.5-rc.4", "1.0.5-rc.3"), true);
    assert.equal(isNewer("1.0.5", "1.0.5-rc.2"), true);
    assert.equal(isNewer("1.0.5-rc.1", "1.0.5"), false);
  });

  it("retains legacy numeric version ordering", () => {
    assert.equal(isNewer("1.0.5", "1.0.4"), true);
    assert.equal(isNewer("0.2.7.7", "0.2.7.6"), true);
    assert.equal(isNewer("1.0.4", "1.0.4"), false);
  });
});
