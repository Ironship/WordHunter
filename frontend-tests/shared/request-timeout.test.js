import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { fetchWithTimeout } = await import("../../dist/web/js/request.js");

describe("fetchWithTimeout", () => {
  it("times out while waiting for response headers", async () => {
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason || new DOMException("aborted", "AbortError")));
    });

    await assert.rejects(fetchWithTimeout("/stalled", {}, 5), /timed out after 5 ms/);
  });

  it("keeps the deadline active while consuming the response body", async () => {
    globalThis.fetch = async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason || new DOMException("aborted", "AbortError")));
      })
    });

    const response = await fetchWithTimeout("/slow-json", {}, 5);
    await assert.rejects(response.json(), /timed out after 5 ms/);
  });

  it("preserves caller cancellation instead of reporting a timeout", async () => {
    globalThis.fetch = async (_url, { signal }) => ({
      ok: true,
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      })
    });
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const response = await fetchWithTimeout("/caller-abort", { signal: controller.signal }, 1000);
    const body = response.text();
    controller.abort(reason);

    await assert.rejects(body, (error) => error === reason);
  });

  it("returns successfully when the body finishes before the deadline", async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => "ready" });
    const response = await fetchWithTimeout("/ready", {}, 1000);
    assert.equal(await response.text(), "ready");
  });
});
