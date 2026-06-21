import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildSavePayload } = await import("../src/web/js/api.js");

describe("profile save payload", () => {
  it("keeps books, texts, and vocabulary from every language profile", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "de" },
      profiles: {
        de: {
          vocab: { haus: { status: "learning" } },
          customTexts: [{ id: "de-custom-home", title: "Haus" }],
          userBooks: [{ id: "de-book" }],
          hiddenBuiltInBooks: ["de-hidden"]
        },
        fr: {
          vocab: { maison: { status: "known" } },
          customTexts: [{ id: "fr-custom-home", title: "Maison" }],
          userBooks: [{ id: "fr-book" }],
          hiddenBuiltInBooks: ["fr-hidden"]
        }
      }
    });

    assert.deepEqual(payload.texts.map((text) => text.id).sort(), ["de-custom-home", "fr-custom-home"]);
    assert.deepEqual(payload.vocab.de.userBooks, [{ id: "de-book" }]);
    assert.deepEqual(payload.vocab.fr.userBooks, [{ id: "fr-book" }]);
    assert.deepEqual(payload.vocab.de.vocab, { haus: { status: "learning" } });
    assert.deepEqual(payload.vocab.fr.vocab, { maison: { status: "known" } });
  });
});
