import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  isOcrImageFile,
  validatedOcrImageFormat,
} = await import(process.env.WORDHUNTER_TEST_SOURCE_TS === "1"
  ? "../../src/web/js/ocr-image-format.ts"
  : "../../dist/web/js/ocr-image-format.js");

describe("OCR image file classification", () => {
  it("accepts supported formats and rejects conflicts or unsupported files", () => {
    for (const type of ["image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream", ""]) {
      assert.equal(validatedOcrImageFormat({ name: "scan.JPEG", type })?.contentType, "image/jpeg");
    }
    assert.equal(validatedOcrImageFormat({ name: "scan", type: "image/pjpeg" })?.extension, "jpg");
    assert.equal(validatedOcrImageFormat({ name: "scan.png", type: "image/png" })?.extension, "png");
    assert.equal(validatedOcrImageFormat({ name: "scan.webp", type: "image/webp" })?.extension, "webp");
    assert.equal(validatedOcrImageFormat({ name: "scan.jpg", type: "image/png" }), null);
    assert.equal(validatedOcrImageFormat({ name: "scan", type: "application/octet-stream" }), null);
    assert.equal(validatedOcrImageFormat({ name: "scan.gif", type: "image/gif" }), null);
    assert.equal(isOcrImageFile({ name: "scan.gif", type: "image/gif" }), true);
    assert.equal(isOcrImageFile({ name: "notes.txt", type: "text/plain" }), false);
  });
});
