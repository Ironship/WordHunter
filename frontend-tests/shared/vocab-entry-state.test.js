import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { isInTextReviewDue } = await import("../../dist/web/js/sm2.js");
const { setEntryStatus } = await import("../../dist/web/js/vocabulary/entry-state.js");

describe("vocabulary entry state helpers", () => {
  it("sets knownAt only on the first known transition", () => {
    const entry = { status: "learning", updatedAt: "old" };

    const previousStatus = setEntryStatus(entry, "known", "2026-06-30T10:00:00.000Z");

    assert.equal(previousStatus, "learning");
    assert.deepEqual(entry, {
      status: "known",
      updatedAt: "2026-06-30T10:00:00.000Z",
      statusUpdatedAt: "2026-06-30T10:00:00.000Z",
      knownAt: "2026-06-30T10:00:00.000Z"
    });

    setEntryStatus(entry, "known", "2026-07-01T10:00:00.000Z");

    assert.equal(entry.updatedAt, "2026-07-01T10:00:00.000Z");
    assert.equal(entry.statusUpdatedAt, "2026-06-30T10:00:00.000Z");
    assert.equal(entry.knownAt, "2026-06-30T10:00:00.000Z");
  });

  it("schedules every first Learning transition for the following day", () => {
    const entry = {
      status: "new",
      addedAt: "2026-07-17T08:00:00.000Z",
      nextDate: "2026-07-17"
    };

    const previousStatus = setEntryStatus(entry, "learning", "2026-07-17T10:00:00.000Z");

    assert.equal(previousStatus, "new");
    assert.equal(entry.statusUpdatedAt, "2026-07-17T10:00:00.000Z");
    assert.equal(entry.learningStartedAt, "2026-07-17T10:00:00.000Z");
    assert.equal(entry.nextDate, "2026-07-18");
    assert.equal(isInTextReviewDue(entry, "2026-07-17"), false);
    assert.equal(isInTextReviewDue(entry, "2026-07-18"), true);
  });
});
