import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanCatalogTitle } from "../../dist/web/js/utils.js";
import { createDefaultState } from "../../dist/web/js/state/defaults.js";
import { normalizeState } from "../../dist/web/js/state/normalize.js";

describe("catalog title cleanup", () => {
  it("strips MARC subfield markers from Gutenberg titles", () => {
    assert.equal(cleanCatalogTitle("Dr. Mabuse, der Spieler : $b Roman"), "Dr. Mabuse, der Spieler: Roman");
    assert.equal(cleanCatalogTitle("Title / $c Author"), "Title / Author");
  });

  it("cleans existing saved Gutenberg book titles during state normalization", () => {
    const defaults = createDefaultState();
    const state = normalizeState({
      ...defaults,
      preferences: { ...defaults.preferences, learningLanguage: "de" },
      profiles: {
        de: {
          vocab: {},
          customTexts: [],
          userBooks: [{ id: "user-123", title: "Dr. Mabuse, der Spieler : $b Roman" }],
          hiddenBuiltInBooks: [],
          archivedBookIds: [],
          preferences: {}
        }
      }
    });

    assert.equal(state.userBooks[0].title, "Dr. Mabuse, der Spieler: Roman");
  });
});
