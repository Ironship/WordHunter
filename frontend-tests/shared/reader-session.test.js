import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { clearReaderSession, getReaderSession } = await import("../../dist/web/js/reader/session.js");

describe("reader token session", () => {
  it("reuses tokenization across page renders and invalidates on meaningful inputs", () => {
    clearReaderSession();
    const book = { id: "book-1", text: "One two three." };
    const first = getReaderSession(book, "en", "modern");
    const second = getReaderSession({ ...book }, "en", "modern");

    assert.equal(second, first);
    assert.equal(first.totalWords, 3);
    assert.deepEqual(first.globalWordIndexes.filter((value) => value >= 0), [0, 1, 2]);
    assert.deepEqual(first.globalCharOffsets.filter((value) => value >= 0), [0, 4, 8]);
    assert.notEqual(getReaderSession({ ...book, text: "Changed text." }, "en", "modern"), first);
    assert.notEqual(getReaderSession(book, "de", "modern"), first);
    assert.notEqual(getReaderSession(book, "en", "classic"), first);
  });

  it("clears stale book loading before cached opens and permits empty OCR corrections", () => {
    const bookActions = readFileSync(new URL("../../dist/web/js/book-actions.js", import.meta.url), "utf8");
    const correction = readFileSync(new URL("../../dist/web/js/reader/ocr-correction.js", import.meta.url), "utf8");
    assert.ok(bookActions.indexOf("clearReaderLoading();") < bookActions.indexOf("if (!bookTexts.has(id) ||"));
    assert.doesNotMatch(correction, /<textarea[^>]*required/);
  });

  it("does not clamp a restored page before the active book body is hydrated", () => {
    const app = readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8");
    const books = readFileSync(new URL("../../dist/web/js/books.js", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../../dist/web/js/reader/renderer.js", import.meta.url), "utf8");
    assert.match(app, /await loadBooksCatalog\(\);\s*ensureCurrentText\(\);[\s\S]*?render\(\);\s*const restoringReaderTextId[\s\S]*?void hydrateCurrentReaderText\(\)/);
    assert.ok(renderer.indexOf("if (!readerBodyReady(current))") < renderer.indexOf("const savedPos = state.readerScrolls"));
    assert.match(books, /await remapReaderBookmarksForAlgorithm\(algorithm, activeId\);/);
    assert.match(books, /renderReaderBookmarks\(activeId\);\s*renderInlineBookmarkIndicators\(activeId\);/);
    assert.match(books, /Boolean\(findBookById\(activeId\)\)/);
    assert.doesNotMatch(books, /!currentTextIds\?\.has\(activeId\)/);
  });
});
