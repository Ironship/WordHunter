import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("image OCR import wiring", () => {
  it("advertises image OCR only after the packaged-runtime capability is enabled", () => {
    const html = read("../../src/web/index.html");
    const platform = read("../../src/web/js/platform.ts");
    const input = html.match(/<input id="import-file"[^>]+accept="([^"]+)"/)?.[1] || "";

    for (const value of [".jpg", ".jpeg", ".png", ".webp", "image/jpeg", "image/png", "image/webp"]) {
      assert.ok(!input.split(",").includes(value), `base picker must not advertise ${value}`);
      assert.ok(platform.includes(value), `capability-gated picker missing ${value}`);
      assert.doesNotMatch(platform.match(/MOBILE_IMPORT_ACCEPT = "([^"]+)"/)?.[1] || "", new RegExp(value.replace(".", "\\.")));
    }
    assert.match(platform, /window\.WH_IMAGE_OCR_AVAILABLE === true/);
    assert.match(platform, /desktopOcrUnavailableFileHint/);
  });

  it("reuses OCR progress, cancellation, cleanup, and reader page records", () => {
    const source = read("../../src/web/js/events/book-import.ts");
    const formats = read("../../src/web/js/ocr-image-format.ts");

    assert.match(source, /MAX_DESKTOP_OCR_IMAGE_BYTES = 32 \* 1024 \* 1024/);
    assert.match(source, /validatedOcrImageFormat\(file\)/);
    for (const mime of ["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp", "application/octet-stream"]) {
      assert.ok(formats.includes(mime));
    }
    assert.match(source, /startOcrProgress\("import\.parsingImageOcr", "import\.ocrImageStatus"/);
    assert.match(source, /fetch\(`\/__import\/image_ocr\/raw\?\$\{params\}`/);
    assert.match(source, /fetch\("\/__import\/ocr\/cancel"/);
    assert.match(source, /Failed to clean incomplete image OCR import/);
    assert.match(source, /pdfOcrPages: pages[\s\S]*pdfOcrPageCount: 1/);
  });

  it("enforces authenticated raw-body and decoder safety boundaries", () => {
    const router = read("../../src-tauri/src/router.rs");
    const backend = read("../../src-tauri/src/pdf_ocr/mod.rs");
    const runner = read("../../src-tauri/ocr-runner/src/main.rs");
    const manifest = read("../../src-tauri/ocr-runner/Cargo.toml");
    const server = read("../../src-tauri/src/server.rs");

    assert.match(router, /MAX_RAW_OCR_IMAGE_BODY: usize = 32 \* 1024 \* 1024/);
    assert.match(router, /"\/__import\/image_ocr\/raw"[\s\S]*request_header\(&request, "Content-Type"\)/);
    assert.match(backend, /data\.starts_with\(&\[0xff, 0xd8, 0xff\]\)/);
    assert.match(backend, /data\.starts_with\(b"\\x89PNG/);
    assert.match(backend, /data\.starts_with\(b"RIFF"\)[\s\S]*b"WEBP"/);
    assert.match(runner, /MAX_IMAGE_DIMENSION: u32 = 16_384/);
    assert.match(runner, /MAX_IMAGE_PIXELS: u64 = 40_000_000/);
    assert.match(runner, /decoder\.orientation\(\)[\s\S]*apply_orientation/);
    assert.match(manifest, /features = \["png", "jpeg", "webp"\]/);
    assert.match(backend, /!cfg!\(any\(windows, target_os = "linux"\)\)/);
    assert.match(server, /struct ActiveOcrJob[\s\S]*state\.active\.remove[\s\S]*state\.cancelled\.remove/);
  });

  it("keeps the enabled WebP decoder represented in locked, offline, and license inputs", () => {
    const lock = read("../../src-tauri/ocr-runner/Cargo.lock");
    const sources = JSON.parse(read("../../flatpak/cargo-sources.json"));
    const licenses = read("../../OCR-THIRD-PARTY-LICENSES.html");

    assert.match(lock, /name = "image-webp"\s+version = "0\.2\.4"/);
    assert.ok(sources.some((source) => source.url?.includes("/image-webp-0.2.4.crate")));
    assert.match(licenses, /image-webp 0\.2\.4/);
  });
});
