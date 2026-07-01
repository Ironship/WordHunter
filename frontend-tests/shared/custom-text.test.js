import { describe, it } from "node:test";
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

const { state } = await import("../../src/web/js/state.js");
const { importCustomText } = await import("../../src/web/js/book-actions/custom-text.js");

describe("custom text import", () => {
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
});
