import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildSavePayload } = await import("../../src/web/js/api.js");
const { loadState } = await import("../../src/web/js/state/normalize.js");

describe("profile save payload", () => {
  it("keeps books, texts, and vocabulary from every language profile", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "de" },
      profiles: {
        de: {
          vocab: { haus: { status: "learning" } },
          customTexts: [{ id: "de-custom-home", title: "Haus", text: "Großes Haus" }],
          userBooks: [{ id: "de-book" }],
          hiddenBuiltInBooks: ["de-hidden"],
          archivedBookIds: ["de-archived"],
          preferences: { dictionaryUrl: "https://de.example/{{word}}" }
        },
        fr: {
          vocab: { maison: { status: "known" } },
          customTexts: [{ id: "fr-custom-home", title: "Maison" }],
          userBooks: [{ id: "fr-book" }],
          hiddenBuiltInBooks: ["fr-hidden"],
          archivedBookIds: ["fr-archived"],
          preferences: { dictionaryUrl: "https://fr.example/{{word}}" }
        }
      }
    });

    assert.deepEqual(payload.texts.map((text) => text.id).sort(), ["de-custom-home", "fr-custom-home"]);
    assert.equal(payload.texts.find((text) => text.id === "de-custom-home").text, "Großes Haus");
    assert.equal(Object.hasOwn(payload.vocab.de, "customTexts"), false);
    assert.equal(Object.hasOwn(payload.vocab.fr, "customTexts"), false);
    assert.deepEqual(payload.vocab.de.userBooks, [{ id: "de-book" }]);
    assert.deepEqual(payload.vocab.fr.userBooks, [{ id: "fr-book" }]);
    assert.deepEqual(payload.vocab.de.hiddenBuiltInBooks, ["de-hidden"]);
    assert.deepEqual(payload.vocab.fr.hiddenBuiltInBooks, ["fr-hidden"]);
    assert.deepEqual(payload.vocab.de.archivedBookIds, ["de-archived"]);
    assert.deepEqual(payload.vocab.fr.archivedBookIds, ["fr-archived"]);
    assert.equal(payload.vocab.de.preferences.dictionaryUrl, "https://de.example/{{word}}");
    assert.equal(payload.vocab.fr.preferences.dictionaryUrl, "https://fr.example/{{word}}");
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

  it("keeps PDF OCR metadata in bridge save payloads", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "de" },
      profiles: {
        de: {
          vocab: {},
          customTexts: [{
            id: "de-pdf",
            title: "PDF",
            text: "Text",
            pdfOcrEngine: "pdfium-text-layer+paddleocr-rs-onnx",
            pdfOcrPageCount: 1,
            pdfOcrPages: [{ imageName: "page-1.png", width: 100, height: 200 }]
          }]
        }
      }
    });

    assert.equal(payload.texts[0].pdfOcrEngine, "pdfium-text-layer+paddleocr-rs-onnx");
    assert.equal(payload.texts[0].pdfOcrPageCount, 1);
    assert.equal(payload.texts[0].pdfOcrPages[0].imageName, "page-1.png");
  });

  it("loads backend snapshots when Android bridge is present", () => {
    globalThis.window = {
      WordHunterAndroid: {},
      __bridgeState: {
        dataDir: "/data/user/0/com.wordhunter.pocket/WordHunter",
        syncDir: "Google Drive",
        prefs: { learningLanguage: "de" },
        vocab: {},
        texts: []
      }
    };
    const restored = loadState();

    assert.equal(restored.dataDirectory, "/data/user/0/com.wordhunter.pocket/WordHunter");
    assert.equal(restored.syncDirectory, "Google Drive");
  });

  it("keeps legacy backend snapshots in the selected learning language", () => {
    globalThis.window = {
      __qtBridge: true,
      __bridgeState: {
        prefs: { learningLanguage: "fr" },
        vocab: { maison: { status: "known" } },
        texts: [{ id: "legacy-book", title: "Maison", text: "texte" }]
      }
    };

    const restored = loadState();

    assert.equal(restored.profiles.fr.customTexts[0].id, "legacy-book");
    assert.equal(restored.profiles.de, undefined);
    assert.equal(restored.vocab.maison.status, "known");
  });

  it("keeps three-letter language prefixes when restoring backend texts", () => {
    globalThis.window = {
      __qtBridge: true,
      __bridgeState: {
        prefs: { learningLanguage: "grc" },
        vocab: { grc: { vocab: {} } },
        texts: [{ id: "grc-custom-iliad", title: "Iliad", text: "μῆνιν ἄειδε" }]
      }
    };

    const restored = loadState();

    assert.equal(restored.profiles.grc.customTexts[0].id, "grc-custom-iliad");
    assert.equal(restored.profiles.grc.customTexts[0].text, "μῆνιν ἄειδε");
  });
});
