import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { searchMediaWiki } = await import("../../src/web/js/discover/mediawiki.js");

describe("MediaWiki discovery sources", () => {
  it("routes Ancient Greek Wikisource searches through Greek Wikisource", async () => {
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          query: {
            pages: {
              123: { pageid: 123, title: "Iliad", extract: "μῆνιν ἄειδε" }
            }
          }
        })
      };
    };

    const data = await searchMediaWiki("wikisource", "grc", "iliad", 1, "popular", null, null);

    assert.match(requestedUrl, /^https:\/\/el\.wikisource\.org\/w\/api\.php/);
    assert.equal(data.results[0].id, "wikisource-123");
    assert.equal(data.results[0].apiLang, "el");
    assert.deepEqual(data.results[0].languages, ["grc"]);
  });
});
