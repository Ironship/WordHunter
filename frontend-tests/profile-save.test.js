import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildSavePayload } = await import("../src/web/js/api.js");
const { loadState } = await import("../src/web/js/state/normalize.js");

describe("profile save payload", () => {
  it("keeps books, texts, and vocabulary from every language profile", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "de" },
      profiles: {
        de: {
          vocab: { haus: { status: "learning" } },
          customTexts: [{ id: "de-custom-home", title: "Haus", text: "Großes Haus" }],
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
    assert.equal(payload.texts.find((text) => text.id === "de-custom-home").text, "Großes Haus");
    assert.equal(Object.hasOwn(payload.vocab.de, "customTexts"), false);
    assert.equal(Object.hasOwn(payload.vocab.fr, "customTexts"), false);
    assert.deepEqual(payload.vocab.de.userBooks, [{ id: "de-book" }]);
    assert.deepEqual(payload.vocab.fr.userBooks, [{ id: "fr-book" }]);
    assert.deepEqual(payload.vocab.de.vocab, { haus: { status: "learning" } });
    assert.deepEqual(payload.vocab.fr.vocab, { maison: { status: "known" } });
  });

  it("round-trips text bodies when profiles omit duplicate customTexts", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "de" },
      profiles: {
        de: { vocab: {}, customTexts: [{ id: "de-text", text: "vollständiger Text" }] },
        fr: { vocab: {}, customTexts: [{ id: "fr-text", text: "texte complet" }] }
      }
    });
    globalThis.window = { __qtBridge: true, __bridgeState: payload };
    const restored = loadState();

    assert.equal(restored.profiles.de.customTexts[0].text, "vollständiger Text");
    assert.equal(restored.profiles.fr.customTexts[0].text, "texte complet");
  });
});
