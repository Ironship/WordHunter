import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  isAiModelCommitKey,
  countAiModelMatches,
  filterAiModels,
  getCachedAiModels,
  isAiModelCacheFresh,
  normalizeAiModels,
  requestAiModels
} = await import("../../dist/web/js/ai-model-discovery.js");

describe("AI model discovery", () => {
  it("filters model ids by every case-insensitive search phrase", () => {
    const models = [
      "qwen3.5-plus",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "gpt-5.6-luna"
    ];

    assert.deepEqual(filterAiModels(models, "  DEEP   flash  "), ["deepseek-v4-flash"]);
    assert.deepEqual(filterAiModels(models, "5.6 luna"), ["gpt-5.6-luna"]);
  });

  it("counts every match even when the visible result list is capped", () => {
    const models = Array.from({ length: 120 }, (_, index) => `provider/model-${index}`);

    assert.equal(filterAiModels(models, "provider").length, 80);
    assert.equal(countAiModelMatches(models, "model"), 120);
  });

  it("recognizes Android IME Enter events that report an unidentified key", () => {
    assert.equal(isAiModelCommitKey({ key: "Enter", keyCode: 0 }), true);
    assert.equal(isAiModelCommitKey({ key: "Unidentified", keyCode: 13 }), true);
    assert.equal(isAiModelCommitKey({ key: "Unidentified", keyCode: 0 }), false);
  });

  it("normalizes an OpenAI model list into sorted unique ids", () => {
    assert.deepEqual(normalizeAiModels({
      object: "list",
      data: [
        { id: " qwen3.5-plus " },
        { id: "deepseek-v4-flash" },
        { id: "qwen3.5-plus" },
        { id: "" },
        { nope: "ignored" }
      ]
    }), ["deepseek-v4-flash", "qwen3.5-plus"]);
  });

  it("requests models through the authenticated local backend", async () => {
    globalThis.window = { WH_TOKEN: "local-token" };
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        data: [{ id: "qwen3.5-plus" }, { id: "deepseek-v4-flash" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const models = await requestAiModels(
      "https://opencode.ai/zen/go/v1/chat/completions",
      "private-key"
    );

    assert.deepEqual(models, ["deepseek-v4-flash", "qwen3.5-plus"]);
    assert.equal(captured.url, "/__ai/models");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers["X-WH-Token"], "local-token");
    assert.deepEqual(JSON.parse(captured.options.body), {
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
      apiKey: "private-key"
    });
  });

  it("cancels discovery when the caller aborts an obsolete request", async () => {
    const previousWindow = globalThis.window;
    const previousFetch = globalThis.fetch;
    const caller = new AbortController();
    let requestSignal;
    globalThis.window = { WH_TOKEN: "local-token" };
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    });

    try {
      const request = requestAiModels("https://example.com/v1/chat/completions", "", caller.signal);
      caller.abort();
      await assert.rejects(request, { name: "AbortError" });
      assert.equal(requestSignal.aborted, true);
    } finally {
      globalThis.window = previousWindow;
      globalThis.fetch = previousFetch;
    }
  });

  it("uses cache only for the same endpoint and reports when it is stale", () => {
    const now = 2_000_000_000_000;
    const cache = {
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
      models: ["qwen3.5-plus", "deepseek-v4-flash", "qwen3.5-plus"],
      fetchedAt: now - 60_000
    };

    assert.deepEqual(getCachedAiModels(cache, cache.endpoint), [
      "deepseek-v4-flash",
      "qwen3.5-plus"
    ]);
    assert.deepEqual(getCachedAiModels(cache, "https://example.com/v1/chat/completions"), []);
    assert.equal(isAiModelCacheFresh(cache, cache.endpoint, now), true);
    assert.equal(isAiModelCacheFresh({ ...cache, fetchedAt: now - 86_400_001 }, cache.endpoint, now), false);
  });
});
