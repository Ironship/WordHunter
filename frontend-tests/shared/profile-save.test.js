import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildSavePayload, saveToLocalStorage } = await import("../../src/web/js/api.js");
const { STATE_SCHEMA_VERSION, STORAGE_KEY } = await import("../../src/web/js/constants.js");
const { createDefaultState } = await import("../../src/web/js/state/defaults.js");
const { loadState, normalizeState } = await import("../../src/web/js/state/normalize.js");

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

    assert.equal(payload.schemaVersion, STATE_SCHEMA_VERSION);
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

  it("removes the duplicate starter text created by the old Gutenberg fallback", () => {
    const raw = createDefaultState();
    raw.preferences.learningLanguage = "ru";
    raw.profiles.ru = {
      vocab: {},
      customTexts: [
        { id: "gutenberg-full-undefined", title: "Duplicate full text" },
        { id: "ru-custom-kept", title: "Keep me" }
      ],
      userBooks: [],
      hiddenBuiltInBooks: [],
      archivedBookIds: [],
      preferences: {}
    };

    const normalized = normalizeState(raw);

    assert.deepEqual(normalized.customTexts.map((text) => text.id), ["ru-custom-kept"]);
    assert.deepEqual(normalized.profiles.ru.customTexts.map((text) => text.id), ["ru-custom-kept"]);
  });

  it("writes raw state with an explicit schema version to the current storage key", () => {
    let storedKey = "";
    let storedValue = "";
    globalThis.localStorage = {
      getItem() { return null; },
      setItem(key, value) {
        storedKey = key;
        storedValue = value;
      },
      removeItem() {}
    };

    saveToLocalStorage({ preferences: { learningLanguage: "de" }, vocab: { haus: { status: "known" } } });

    assert.equal(storedKey, STORAGE_KEY);
    assert.equal(JSON.parse(storedValue).schemaVersion, STATE_SCHEMA_VERSION);
  });

  it("does not throw when localStorage quota rejects a cache write", () => {
    globalThis.localStorage = {
      getItem() { return null; },
      setItem() { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem() {}
    };
    const originalError = console.error;
    console.error = () => {};

    try {
      assert.doesNotThrow(() => {
        saveToLocalStorage({ preferences: { learningLanguage: "de" }, vocab: { haus: { status: "known" } } });
      });
    } finally {
      console.error = originalError;
    }
  });

  it("preserves shared active-profile references when saving localStorage", () => {
    let storedValue = "";
    globalThis.localStorage = {
      getItem() { return null; },
      setItem(_key, value) { storedValue = value; },
      removeItem() {}
    };
    const profile = {
      vocab: { haus: { status: "known" } },
      customTexts: [{ id: "de-text", title: "Text" }],
      userBooks: [{ id: "de-book" }],
      hiddenBuiltInBooks: ["de-hidden"],
      archivedBookIds: ["de-archived"]
    };
    const rawState = {
      ...createDefaultState(),
      preferences: { learningLanguage: "de" },
      profiles: { de: profile },
      vocab: profile.vocab,
      customTexts: profile.customTexts,
      userBooks: profile.userBooks,
      hiddenBuiltInBooks: profile.hiddenBuiltInBooks,
      archivedBookIds: profile.archivedBookIds
    };

    saveToLocalStorage(rawState);
    const saved = JSON.parse(storedValue);

    assert.deepEqual(saved.vocab, { haus: { status: "known" } });
    assert.deepEqual(saved.profiles.de.vocab, { haus: { status: "known" } });
    assert.deepEqual(saved.profiles.de.customTexts, [{ id: "de-text", title: "Text" }]);
  });

  it("normalizes malformed profile and vocabulary entries without dropping the whole state", () => {
    const restored = normalizeState({
      ...createDefaultState(),
      preferences: { learningLanguage: "de" },
      profiles: {
        de: {
          vocab: {
            haus: { status: "known" },
            broken: null,
            "also-broken": "known"
          },
          customTexts: [{ id: "de-text", title: "Text" }, "bad"],
          userBooks: ["bad", { id: "de-book", title: "Book" }],
          hiddenBuiltInBooks: ["hidden", 7],
          archivedBookIds: [{ id: "bad" }, "archived"]
        },
        fr: "not-a-profile"
      }
    });

    assert.equal(restored.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(restored.vocab), ["haus"]);
    assert.equal(restored.vocab.haus.status, "known");
    assert.deepEqual(restored.customTexts, [{ id: "de-text", title: "Text" }]);
    assert.deepEqual(restored.userBooks, [{ id: "de-book", title: "Book" }]);
    assert.deepEqual(restored.hiddenBuiltInBooks, ["hidden"]);
    assert.deepEqual(restored.archivedBookIds, ["archived"]);
    assert.deepEqual(restored.profiles.fr.customTexts, []);
    assert.deepEqual(restored.profiles.fr.vocab, {});
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

  it("round-trips Discover source through bridge snapshots", () => {
    const payload = buildSavePayload({
      preferences: { learningLanguage: "uk" },
      discover: { query: "kobzar", source: "wikisource", sort: "newest", level: "B1", page: 2 },
      profiles: { uk: { vocab: {}, customTexts: [] } }
    });

    assert.deepEqual(payload.prefs.__discover, {
      query: "kobzar",
      source: "wikisource",
      sort: "newest",
      level: "B1",
      page: 2
    });

    globalThis.window = { __qtBridge: true, __bridgeState: payload };
    const restored = loadState();

    assert.equal(restored.discover.source, "wikisource");
    assert.equal(restored.discover.query, "kobzar");
    assert.equal(restored.discover.page, 2);
    assert.equal(Object.hasOwn(restored.preferences, "__discover"), false);
  });

  it("loads backend snapshots when Android bridge is present", () => {
    globalThis.window = {
      WordHunterAndroid: {},
      __bridgeState: {
        schemaVersion: STATE_SCHEMA_VERSION,
        dataDir: "/data/user/0/com.wordhunter.pocket/WordHunter",
        syncDir: "Google Drive",
        syncConflictCount: 3,
        syncConflicts: [{ id: "abc", key: "vocab:de:haus" }],
        recoveryStatus: {
          schemaVersion: 1,
          skippedRecordCount: 1,
          skippedRecords: [{ path: "records/v1/vocab/bad.json", kind: "vocab", error: "corrupt" }],
          corruptConflictCount: 0,
          pendingSaveJournal: true
        },
        prefs: { learningLanguage: "de" },
        vocab: { de: { vocab: {} } },
        texts: []
      }
    };
    const restored = loadState();

    assert.equal(restored.dataDirectory, "/data/user/0/com.wordhunter.pocket/WordHunter");
    assert.equal(restored.syncDirectory, "Google Drive");
    assert.equal(restored.syncConflictCount, 3);
    assert.deepEqual(restored.syncConflicts, [{
      id: "abc",
      key: "vocab:de:haus",
      reason: "",
      timestamp: "",
      kept: {},
      conflict: {}
    }]);
    assert.equal(restored.recoveryStatus.skippedRecordCount, 1);
    assert.equal(restored.recoveryStatus.skippedRecords[0].path, "records/v1/vocab/bad.json");
    assert.equal(restored.recoveryStatus.pendingSaveJournal, true);
    assert.equal(restored.recoveryStatus.pendingWipeJournal, false);
  });

  it("keeps three-letter language prefixes when restoring backend texts", () => {
    globalThis.window = {
      __qtBridge: true,
      __bridgeState: {
        schemaVersion: STATE_SCHEMA_VERSION,
        prefs: { learningLanguage: "grc" },
        vocab: { grc: { vocab: {} } },
        texts: [{ id: "grc-custom-iliad", title: "Iliad", text: "μῆνιν ἄειδε" }]
      }
    };

    const restored = loadState();

    assert.equal(restored.profiles.grc.customTexts[0].id, "grc-custom-iliad");
    assert.equal(restored.profiles.grc.customTexts[0].text, "μῆνιν ἄειδε");
  });

  it("uses defaults when the localStorage cache is absent", () => {
    globalThis.window = { __qtBridge: false };
    globalThis.localStorage = {
      getItem(key) {
        assert.equal(key, STORAGE_KEY);
        return null;
      },
      setItem() {},
      removeItem() {}
    };

    const restored = loadState();

    assert.equal(restored.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual(restored.vocab, {});
  });

  it("rejects future localStorage caches instead of downgrading them", () => {
    globalThis.window = { __qtBridge: false };
    globalThis.localStorage = {
      getItem(key) {
        assert.equal(key, STORAGE_KEY);
        return JSON.stringify({
          schemaVersion: STATE_SCHEMA_VERSION + 1,
          preferences: { learningLanguage: "de" },
          profiles: { de: { vocab: { future: { status: "known" } } } }
        });
      },
      setItem() {},
      removeItem() {}
    };

    const restored = loadState();

    assert.equal(restored.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(restored.vocab.future, undefined);
  });

  it("rejects future bridge snapshots instead of overwriting current records", () => {
    globalThis.window = {
      __qtBridge: true,
      __bridgeState: {
        schemaVersion: STATE_SCHEMA_VERSION + 1,
        prefs: { learningLanguage: "de" },
        vocab: { de: { vocab: { future: { status: "known" } } } },
        texts: []
      }
    };

    assert.throws(() => loadState(), /schema version/);
  });

  it("prefers a valid bridge snapshot over stale localStorage cache", () => {
    globalThis.localStorage = {
      getItem(key) {
        assert.equal(key, STORAGE_KEY);
        return JSON.stringify({
          schemaVersion: STATE_SCHEMA_VERSION,
          preferences: { learningLanguage: "de" },
          profiles: {
            de: {
              vocab: { alt: { word: "alt", translation: "old", status: "known" } },
              customTexts: [],
              userBooks: [],
              hiddenBuiltInBooks: [],
              archivedBookIds: [],
              preferences: {}
            }
          }
        });
      },
      setItem() {},
      removeItem() {}
    };
    globalThis.window = {
      __qtBridge: true,
      __bridgeState: {
        schemaVersion: STATE_SCHEMA_VERSION,
        prefs: { learningLanguage: "de" },
        vocab: {
          de: {
            preferences: {},
            vocab: { neu: { word: "neu", translation: "new", status: "learning" } }
          }
        },
        texts: []
      }
    };

    const restored = loadState();

    assert.equal(restored.vocab.neu.translation, "new");
    assert.equal(restored.vocab.alt, undefined);
  });
});
