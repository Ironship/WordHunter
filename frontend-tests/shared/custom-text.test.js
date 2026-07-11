import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  addEventListener() {},
  dispatchEvent() {}
};

globalThis.document = {
  documentElement: { lang: "en", style: {}, classList: { add() {}, remove() {}, toggle() {} } },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { createDefaultState, replaceState, state } = await import("../../src/web/js/state.js");
const { bookTexts } = await import("../../src/web/js/books.js");
const { els } = await import("../../src/web/js/dom.js");
const { importCustomText, updatePdfOcrPageText } = await import("../../src/web/js/book-actions/custom-text.js");
const {
  countEffectivePdfPageWords,
  findPdfSentenceRange,
  reconcilePdfPageWords
} = await import("../../src/web/js/reader/pdf-page-text.js");
const { bindBookImportEvents } = await import("../../src/web/js/events/book-import.js");
const { getOrCreateEntry } = await import("../../src/web/js/views/vocabulary.js");
const { mapPdfOverlayWordIndexes } = await import("../../src/web/js/reader/pdf-ocr-renderer.js");
const { upsertStoredText } = await import("../../src/web/js/store-bridge.js");

function busyElement(extra = {}) {
  return {
    classList: { toggle() {} },
    setAttribute() {},
    removeAttribute() {},
    ...extra
  };
}

describe("custom text import", () => {
  beforeEach(() => {
    window.__qtBridge = false;
    globalThis.fetch = undefined;
    bookTexts.clear();
    const defaults = createDefaultState();
    replaceState(defaults, { save: false });
  });

  it("keeps existing PDF OCR overlay metadata when an update has no pages", async () => {
    state.preferences.learningLanguage = "de";
    state.customTexts = [{
      id: "de-pdf",
      title: "PDF",
      text: "old text",
      coverDataUrl: "/__media?book=de-pdf&img=page-1.png",
      pdfOcrEngine: "pdfium-text-layer+paddleocr-rs-onnx",
      pdfOcrPageCount: 2,
      pdfOcrPages: [{ imageName: "page-1.png", width: 100, height: 200 }],
      experimental: true
    }];

    await importCustomText("PDF", "new text from Pocket", { id: "de-pdf" }, false);

    assert.equal(state.customTexts.length, 1);
    assert.equal(state.customTexts[0].text, "new text from Pocket");
    assert.equal(state.customTexts[0].coverDataUrl, "/__media?book=de-pdf&img=page-1.png");
    assert.equal(state.customTexts[0].pdfOcrEngine, "pdfium-text-layer+paddleocr-rs-onnx");
    assert.equal(state.customTexts[0].pdfOcrPageCount, 2);
    assert.equal(state.customTexts[0].pdfOcrPages[0].imageName, "page-1.png");
    assert.equal(state.customTexts[0].experimental, true);
  });

  it("does not mutate profile or text cache when bridge upsert fails", async () => {
    window.__qtBridge = true;
    state.preferences.learningLanguage = "de";
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const id = await importCustomText("Unsafe", "body text", { id: "de-custom-unsafe" }, false);

    assert.equal(id, null);
    assert.deepEqual(state.customTexts, []);
    assert.equal(bookTexts.has("de-custom-unsafe"), false);
    assert.deepEqual(calls, ["/__store/upsert_text"]);
  });

  it("keeps unsaved form contents when bridge import fails", async () => {
    window.__qtBridge = true;
    state.preferences.learningLanguage = "de";
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    let submitHandler;
    let resetCalled = false;
    els.importForm = busyElement({
      addEventListener(type, handler) {
        if (type === "submit") submitHandler = handler;
      },
      reset() { resetCalled = true; }
    });
    els.importTitle = { value: "Unsaved title" };
    els.importText = { value: "Unsaved body" };
    els.importAuthor = { value: "Unsaved author" };
    els.importTags = { value: "draft" };
    els.importLevel = { value: "B1" };
    const submitButton = busyElement({ disabled: false });
    bindBookImportEvents();

    await submitHandler({ preventDefault() {}, submitter: submitButton });

    assert.equal(resetCalled, false);
    assert.equal(els.importTitle.value, "Unsaved title");
    assert.equal(els.importText.value, "Unsaved body");
    assert.equal(submitButton.disabled, false);
  });

  it("stores page-scoped OCR corrections and updates the overlay words", async () => {
    state.preferences.learningLanguage = "de";
    state.customTexts = [{
      id: "de-pdf-correction",
      title: "Scan",
      text: "D as Haus\n\nSecond page",
      pdfOcrPages: [
        {
          text: "D as Haus",
          imageName: "page-1.png",
          width: 100,
          height: 200,
          words: [{ text: "D", x: 1 }, { text: "as", x: 2 }, { text: "Haus", x: 3 }]
        },
        { text: "Second page", imageName: "page-2.png", width: 100, height: 200 }
      ]
    }];

    assert.equal(await updatePdfOcrPageText("de-pdf-correction", 0, "Das Haus"), true);

    const saved = state.customTexts[0];
    assert.equal(saved.pdfOcrPages[0].text, "D as Haus");
    assert.equal(saved.pdfOcrPages[0].correctedText, "Das Haus");
    assert.equal(saved.pdfOcrPages[0].imageName, "page-1.png");
    assert.deepEqual(saved.pdfOcrPages[0].words.map((word) => word.text), ["Das", "Haus"]);
    assert.equal(saved.pdfOcrPages[0].words[0].x, 1);
    assert.equal(saved.pdfOcrPages[0].words[1].x, 3);
    assert.equal(bookTexts.get(saved.id), "Das Haus\n\nSecond page");

    assert.equal(await updatePdfOcrPageText("de-pdf-correction", 0, "D as Haus"), true);
    assert.equal(Object.hasOwn(state.customTexts[0].pdfOcrPages[0], "correctedText"), false);
    assert.deepEqual(state.customTexts[0].pdfOcrPages[0].words.map((word) => word.text), ["D", "as", "Haus"]);
  });

  it("merges and splits corrected OCR geometry without shifting anchored words", () => {
    const words = [
      { text: "D", x: 10, y: 20, width: 8, height: 12 },
      { text: "as", x: 19, y: 20, width: 11, height: 12 },
      { text: "Haus", x: 34, y: 20, width: 30, height: 12 }
    ];
    const merged = reconcilePdfPageWords(words, "Das Haus", "de", "modern");
    assert.deepEqual(merged.map((word) => word.text), ["Das", "Haus"]);
    assert.deepEqual(
      { x: merged[0].x, y: merged[0].y, width: merged[0].width, height: merged[0].height },
      { x: 10, y: 20, width: 20, height: 12 }
    );
    assert.deepEqual(
      { x: merged[1].x, width: merged[1].width },
      { x: 34, width: 30 }
    );

    const split = reconcilePdfPageWords([{ text: "wordpair", x: 5, y: 8, width: 80, height: 10 }], "word pair");
    assert.deepEqual(split.map((word) => word.text), ["word", "pair"]);
    assert.equal(split[0].x, 5);
    assert.equal(split[0].width + split[1].width, 80);
    assert.equal(split[1].x, split[0].x + split[0].width);
  });

  it("finds the selected repeated sentence by local word index", () => {
    const text = "The bank is closed. We walked by the river bank after lunch.";
    const range = findPdfSentenceRange(text, 9, "en", "modern");
    assert.equal(text.slice(range.start, range.end), "We walked by the river bank after lunch.");
  });

  it("allows false OCR on the only page to be cleared", async () => {
    state.preferences.learningLanguage = "de";
    state.customTexts = [{
      id: "de-pdf-empty-correction",
      title: "Blank scan",
      text: "False OCR",
      pdfOcrPages: [{ text: "False OCR", imageName: "page-1.png", words: [] }]
    }];

    assert.equal(await updatePdfOcrPageText("de-pdf-empty-correction", 0, ""), true);
    assert.equal(state.customTexts[0].pdfOcrPages[0].correctedText, "");
    assert.equal(bookTexts.get("de-pdf-empty-correction"), "");
  });

  it("stores context from the selected repeated occurrence", () => {
    const text = "The bank is closed. We walked by the river bank after lunch.";
    const entry = getOrCreateEntry("bank", text, 9);
    assert.equal(entry.examples[0], "We walked by the river bank after lunch.");
  });

  it("maps preserved overlay words only to matching corrected-text positions", () => {
    const words = [{ text: "D" }, { text: "as" }, { text: "Haus" }];
    assert.deepEqual(mapPdfOverlayWordIndexes(words, "Das Haus", "de", "modern", 20), [null, null, 21]);
    assert.deepEqual(mapPdfOverlayWordIndexes(words, "D as Haus", "de", "modern"), [0, 1, 2]);
    assert.deepEqual(
      mapPdfOverlayWordIndexes([{ text: "bank" }, { text: "x" }, { text: "bank" }], "x bank", "en", "modern"),
      [null, 0, 1]
    );
  });

  it("allows an explicitly empty text only for correction persistence", async () => {
    window.__qtBridge = true;
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    };
    await assert.rejects(upsertStoredText({ id: "de-empty", text: "" }), /non-empty text/);
    await upsertStoredText({ id: "de-empty", text: "" }, { allowEmpty: true });
    assert.deepEqual(calls, [{ id: "de-empty", text: "" }]);
  });

  it("uses corrected page word counts for following PDF page offsets", () => {
    const page = {
      text: "D as Haus",
      correctedText: "Das sehr große Haus",
      words: [{ text: "D" }, { text: "as" }, { text: "Haus" }]
    };

    assert.equal(countEffectivePdfPageWords(page, "de", "modern"), 4);
  });

  it("rejects an OCR correction based on stale metadata", async () => {
    state.customTexts = [{
      id: "de-pdf-stale",
      updatedAt: "new-revision",
      pdfOcrPages: [{ text: "Original" }]
    }];

    assert.equal(await updatePdfOcrPageText(
      "de-pdf-stale",
      0,
      "Stale edit",
      { expectedUpdatedAt: "old-revision" }
    ), false);
    assert.equal(state.customTexts[0].pdfOcrPages[0].correctedText, undefined);
  });
});
