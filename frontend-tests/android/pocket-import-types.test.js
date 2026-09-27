// Pocket import file types. The Android picker filters on the provider's MIME
// type, so MOBILE_IMPORT_ACCEPT also offers application/octet-stream (how
// providers that do not know .md/.ass/.ssa report them). The import loader
// then has to accept those by extension and reject everything else (MOBI/AZW,
// binaries) with a localized message instead of decoding it as text.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const subtitles = await import("../../dist/web/js/subtitles.js");
const ocrImageFormat = await import("../../dist/web/js/ocr-image-format.js");

async function evaluateWithMocks(file, importValues, globals = {}) {
  const context = vm.createContext({ console, TextEncoder, ...globals });
  const modules = new Map();
  for (const [specifier, values] of Object.entries(importValues)) {
    modules.set(specifier, new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context, identifier: `mock:${specifier}` }
    ));
  }
  const getModule = (specifier) => {
    const dependency = modules.get(specifier);
    assert.ok(dependency, `unexpected import ${specifier} from ${file}`);
    return dependency;
  };
  const module = new vm.SourceTextModule(read(file), {
    context,
    identifier: new URL(`../../${file}`, import.meta.url).href
  });
  await module.link(getModule);
  await module.evaluate();
  return module.namespace;
}

async function importLoader({ android }) {
  const calls = [];
  const importText = { value: "" };
  const { loadImportFile } = await evaluateWithMocks("dist/web/js/events/book-import/loaders.js", {
    "../../state.js": { state: { preferences: { learningLanguage: "en" } } },
    "../../i18n.js": { t: (key) => key },
    "../../subtitles.js": {
      decodeImportedTextBytes: subtitles.decodeImportedTextBytes,
      parseImportedTextFile: subtitles.parseImportedTextFile,
      titleFromImportedFileName: subtitles.titleFromImportedFileName
    },
    "../../platform.js": { isAndroidPlatform: () => android },
    "../../translator-preferences.js": { effectiveLearningLanguage: () => "en" },
    "../../ocr-image-format.js": { isOcrImageFile: ocrImageFormat.isOcrImageFile },
    "./shared.js": {
      autofillImportCover() {},
      autofillImportField(field, value) { calls.push(["autofill", field, value]); },
      clearAutofilledImportFields() {},
      clearPendingImportMeta() {},
      el: (id) => (id === "import-text" ? importText : null),
      isEbookFile: (file) => /\.(epub|mobi|azw|azw3)$/i.test(file?.name || ""),
      isPdfFile: (file) => file?.type === "application/pdf" || /\.pdf$/i.test(file?.name || ""),
      setImportLoading() {},
      MAX_DESKTOP_IMPORT_FILE_BYTES: 64 * 1024 * 1024,
      MAX_POCKET_IMPORT_FILE_BYTES: 16 * 1024 * 1024,
      MAX_SERIALIZED_IMPORT_TEXT_BYTES: 64 * 1024 * 1024
    },
    "./youtube.js": { resetYoutubeTracks() {} },
    "./pdf-ocr.js": {
      async importPdfFile(file) { calls.push(["pdf", file.name]); },
      async importOcrImageFile(file) { calls.push(["image", file.name]); }
    },
    "./loaders-ebook.js": {
      async importEbookFile(file) { calls.push(["ebook", file.name]); return { text: "Ebook text" }; }
    }
  });
  const file = (name, text = "Hello world", type = "application/octet-stream") => ({
    name,
    type,
    size: text.length,
    async arrayBuffer() {
      calls.push(["read", name]);
      return new TextEncoder().encode(text).buffer;
    }
  });
  return { loadImportFile, file, calls, importText };
}

describe("Pocket import file types", () => {
  it("lets the Android picker offer files the provider reports as application/octet-stream", () => {
    const platform = read("src/web/js/platform.ts");
    const accept = platform.match(/const MOBILE_IMPORT_ACCEPT = "([^"]+)"/)?.[1] || "";
    assert.ok(accept.split(",").includes("application/octet-stream"));
    assert.ok(accept.split(",").includes("text/markdown"));
    assert.ok(accept.split(",").includes("text/x-ssa"));
  });

  it("imports .md, .markdown, .ass and .ssa files reported as application/octet-stream", async () => {
    const { loadImportFile, file, calls, importText } = await importLoader({ android: true });

    await loadImportFile(file("Notes.md", "# Notes\n\nSome text"));
    assert.equal(importText.value, "# Notes\n\nSome text");
    await loadImportFile(file("Chapter.MARKDOWN", "Chapter text"));
    assert.equal(importText.value, "Chapter text");
    await loadImportFile(file("Episode.ass", "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Guten Tag"));
    assert.equal(importText.value, "Guten Tag");
    await loadImportFile(file("Episode.ssa", "[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hallo"));
    assert.equal(importText.value, "Hallo");
    assert.deepEqual(calls.filter(([kind]) => kind === "read").map(([, name]) => name), ["Notes.md", "Chapter.MARKDOWN", "Episode.ass", "Episode.ssa"]);
  });

  it("rejects MOBI/AZW and other files on Android without decoding them", async () => {
    const { loadImportFile, file, calls, importText } = await importLoader({ android: true });

    for (const name of ["Book.mobi", "Book.azw3", "archive.zip", "photo.bin", "README"]) {
      await assert.rejects(loadImportFile(file(name, "\u0000\u0001binary")), { message: "toast.mobileImportUnsupported" }, name);
    }
    assert.deepEqual(calls, []);
    assert.equal(importText.value, "");

    await loadImportFile(file("Book.epub"));
    await loadImportFile(file("Scan.pdf", "", "application/pdf"));
    assert.deepEqual(calls, [["ebook", "Book.epub"], ["autofill", "title", "Book"], ["autofill", "author", ""], ["pdf", "Scan.pdf"]]);
  });

  it("keeps the desktop import dispatch unchanged", async () => {
    const { loadImportFile, file, calls } = await importLoader({ android: false });

    await loadImportFile(file("Book.mobi"));
    assert.deepEqual(calls[0], ["ebook", "Book.mobi"]);
  });

  it("shows the rejection as a localized toast", async () => {
    const { safeImportErrorMessage } = await evaluateWithMocks("dist/web/js/events/book-import/shared.js", {
      "../../state.js": { state: {} },
      "../../i18n.js": { t: (key) => key },
      "./ocr-progress.js": { MAX_POCKET_PDF_BYTES: 1, MAX_DESKTOP_PDF_BYTES: 1, ANDROID_PDF_RENDER_MAX_BASE64_MB: 1 },
      "../../loading.js": { setElementBusy() {} },
      "../../subtitles.js": { titleFromImportedFileName: subtitles.titleFromImportedFileName }
    }, { Error });
    assert.equal(safeImportErrorMessage(new Error("toast.mobileImportUnsupported")), "toast.mobileImportUnsupported");
  });
});
