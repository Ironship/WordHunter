import { describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { dispatchEvent: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { state } = await import("../../src/web/js/state.js");
const { bookTexts, loadAllBookTexts, loadBooksCatalog } = await import("../../src/web/js/books.js");

describe("full-text hydration", () => {
  it("loads every book while keeping at most two text fetches active", async () => {
    state.preferences.learningLanguage = "en";
    let active = 0;
    let peak = 0;
    globalThis.fetch = async (url) => {
      if (url === "books/index.json") {
        return { ok: true, json: async () => ["one", "two", "three"].map((id) => ({ id, lang: "en", textUrl: `/${id}` })) };
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, text: async () => `${url} ${"word ".repeat(50)}` };
    };

    await loadBooksCatalog();
    await loadAllBookTexts();

    assert.equal(peak, 2);
    assert.deepEqual([...bookTexts.keys()].sort(), ["one", "three", "two"]);
  });
});
