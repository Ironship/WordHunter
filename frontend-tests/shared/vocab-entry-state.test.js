import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { setEntryStatus } = await import("../../dist/web/js/vocabulary/entry-state.js");

describe("vocabulary entry state helpers", () => {
  it("sets knownAt only on the first known transition", () => {
    const entry = { status: "learning", updatedAt: "old" };

    const previousStatus = setEntryStatus(entry, "known", "2026-06-30T10:00:00.000Z");

    assert.equal(previousStatus, "learning");
    assert.deepEqual(entry, {
      status: "known",
      updatedAt: "2026-06-30T10:00:00.000Z",
      knownAt: "2026-06-30T10:00:00.000Z"
    });

    setEntryStatus(entry, "known", "2026-07-01T10:00:00.000Z");

    assert.equal(entry.updatedAt, "2026-07-01T10:00:00.000Z");
    assert.equal(entry.knownAt, "2026-06-30T10:00:00.000Z");
  });
});
