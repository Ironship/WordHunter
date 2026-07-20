import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { mediaWikiBookId, searchMediaWiki } = await import("../../dist/web/js/discover/mediawiki.js");

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
    assert.equal(data.results[0].id, "mw-wikisource-el-123");
    assert.equal(data.results[0].apiLang, "el");
    assert.deepEqual(data.results[0].languages, ["grc"]);
  });

  it("namespaces identical page IDs by source and API language", () => {
    assert.equal(mediaWikiBookId("wikipedia", "de", 123), "mw-wikipedia-de-123");
    assert.equal(mediaWikiBookId("wikinews", "fr", 123), "mw-wikinews-fr-123");
    assert.notEqual(
      mediaWikiBookId("wikipedia", "de", 123),
      mediaWikiBookId("wikinews", "fr", 123)
    );
  });

  it("namespaces stored page IDs by Word Hunter profile", () => {
    assert.equal(
      mediaWikiBookId("wikipedia", "en", 123, "en"),
      "mw-en-wikipedia-en-123"
    );
    assert.notEqual(
      mediaWikiBookId("wikipedia", "en", 123, "en"),
      mediaWikiBookId("wikipedia", "en", 123, "other")
    );
  });
});
