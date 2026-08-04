import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __qtBridge: false,
  WH_TOKEN: "test-token",
  addEventListener() {},
  dispatchEvent() {}
};
globalThis.document = {
  documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
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

const { state, replaceState } = await import("../../dist/web/js/state.js");
const {
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  normalizeAiTextPreference,
  aiExplanationConfigured,
  requestAiExplanation,
  requestAiExplanationStream,
  explainWord,
  clearExplanationCache,
  formatAiExplanation
} = await import("../../dist/web/js/ai-explainer.js");

function sseResponse(chunks, contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": contentType } }
  );
}

function workingLocalStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  };
}

describe("ai-explainer", () => {
  beforeEach(() => {
    replaceState({
      ...state,
      preferences: {
        ...state.preferences,
        aiExplanationsEnabled: true,
        aiExplanationEndpoint: "https://opencode.ai/zen/go/v1/chat/completions",
        aiExplanationApiKey: "secret-key",
        aiExplanationModel: "deepseek-v4-flash"
      }
    });
  });

  it("normalizes text preferences with defaults", () => {
    assert.equal(normalizeAiTextPreference("aiExplanationEndpoint", ""), DEFAULT_AI_ENDPOINT);
    assert.equal(normalizeAiTextPreference("aiExplanationEndpoint", "  https://example.com/v1/chat/completions  "), "https://example.com/v1/chat/completions");
    assert.equal(normalizeAiTextPreference("aiExplanationModel", ""), DEFAULT_AI_MODEL);
    assert.equal(normalizeAiTextPreference("aiExplanationModel", "  my-model  "), "my-model");
    assert.equal(normalizeAiTextPreference("aiExplanationApiKey", "  abc  "), "abc");
  });

  it("is configured only when enabled and endpoint and model are set", () => {
    state.preferences.aiExplanationsEnabled = true;
    state.preferences.aiExplanationEndpoint = DEFAULT_AI_ENDPOINT;
    state.preferences.aiExplanationModel = "m";
    assert.equal(aiExplanationConfigured(), true);

    state.preferences.aiExplanationsEnabled = false;
    assert.equal(aiExplanationConfigured(), false);

    state.preferences.aiExplanationsEnabled = true;
    state.preferences.aiExplanationModel = "";
    assert.equal(aiExplanationConfigured(), false);

    state.preferences.aiExplanationModel = "m";
    state.preferences.aiExplanationEndpoint = "";
    assert.equal(aiExplanationConfigured(), false);
  });

  it("posts word, context and credentials to /__ai/explain", async () => {
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ explanation: "Wyjaśnienie.", engine: "ai" }) };
    };

    const result = await requestAiExplanation({
      word: "run",
      context: "She will run a marathon.",
      from: "en",
      to: "pl"
    });
    assert.equal(result.explanation, "Wyjaśnienie.");
    assert.equal(captured.url, "/__ai/explain");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers["X-WH-Token"], "test-token");
    const body = JSON.parse(captured.options.body);
    assert.equal(body.word, "run");
    assert.equal(body.context, "She will run a marathon.");
    assert.equal(body.from, "en");
    assert.equal(body.to, "pl");
    assert.equal(body.endpoint, DEFAULT_AI_ENDPOINT);
    assert.equal(body.apiKey, "secret-key");
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.image, undefined);
    assert.equal(body.rect, undefined);
  });

  it("includes the page image and rect when provided", async () => {
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, json: async () => ({ explanation: "ok", engine: "ai" }) };
    };

    await requestAiExplanation({
      word: "run",
      context: "",
      from: "en",
      to: "pl",
      image: "data:image/jpeg;base64,/9j/4AAQ",
      rect: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 }
    });
    assert.equal(captured.image, "data:image/jpeg;base64,/9j/4AAQ");
    assert.deepEqual(captured.rect, { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 });
  });

  it("surfaces the backend error message", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "AI endpoint returned HTTP 400: model not found"
    });
    await assert.rejects(
      requestAiExplanation({ word: "run", context: "", from: "en", to: "pl" }),
      /model not found/
    );
  });

  it("formats paragraphs and bold spans and escapes HTML", () => {
    const html = formatAiExplanation("Pierwszy akapit z **pogrubieniem**.\n\nDrugi <script>alert(1)</script> akapit.");
    assert.equal(html, "<p>Pierwszy akapit z <strong>pogrubieniem</strong>.</p><p>Drugi &lt;script&gt;alert(1)&lt;/script&gt; akapit.</p>");
    assert.equal(formatAiExplanation("   \n\n  "), "");
  });

  it("streams SSE deltas progressively", async () => {
    globalThis.fetch = async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"To\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\" jest\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\" pies.\"}}]}\n\n",
      "data: [DONE]\n\n"
    ]);
    const deltas = [];
    const result = await requestAiExplanationStream(
      { word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" },
      (text) => deltas.push(text)
    );
    assert.equal(result.streamed, true);
    assert.equal(result.explanation, "To jest pies.");
    assert.deepEqual(deltas, ["To", "To jest", "To jest pies."]);
  });

  it("falls back to a plain JSON body when the endpoint ignores streaming", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ explanation: "Cała odpowiedź.", engine: "ai" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const deltas = [];
    const result = await requestAiExplanationStream(
      { word: "Hund", context: "", from: "de", to: "pl" },
      (text) => deltas.push(text)
    );
    assert.equal(result.streamed, false);
    assert.equal(result.explanation, "Cała odpowiedź.");
    assert.deepEqual(deltas, []);
  });

  it("skips reasoning deltas and surfaces SSE errors", async () => {
    globalThis.fetch = async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"secret thinking\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Odpowiedź\"}}]}\n\n",
      "data: [DONE]\n\n"
    ]);
    const result = await requestAiExplanationStream({ word: "x", context: "", from: "de", to: "pl" });
    assert.equal(result.explanation, "Odpowiedź");

    globalThis.fetch = async () => sseResponse([
      "data: {\"error\":{\"message\":\"rate limited\"}}\n\n"
    ]);
    await assert.rejects(
      requestAiExplanationStream({ word: "x", context: "", from: "de", to: "pl" }),
      /rate limited/
    );
  });

  it("serves cached explanations without a second request", async () => {
    globalThis.localStorage = workingLocalStorage();
    clearExplanationCache();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"Zapisane\"}}]}\n\n",
        "data: [DONE]\n\n"
      ]);
    };

    const first = await explainWord({ word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" });
    assert.equal(first.cached, false);
    assert.equal(first.explanation, "Zapisane");

    const second = await explainWord({ word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" });
    assert.equal(second.cached, true);
    assert.equal(second.explanation, "Zapisane");
    assert.equal(fetchCount, 1, "cache hit must not hit the network");

    // Different context => different cache key => new request
    const third = await explainWord({ word: "Hund", context: "Der Hund schläft.", from: "de", to: "pl" });
    assert.equal(third.cached, false);
    assert.equal(fetchCount, 2);

    clearExplanationCache();
  });

  it("falls back to the non-streaming endpoint when streaming fails", async () => {
    globalThis.localStorage = workingLocalStorage();
    clearExplanationCache();
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (url === "/__ai/explain_stream") {
        throw new Error("stream endpoint down");
      }
      return new Response(
        JSON.stringify({ explanation: "Awaryjna odpowiedź.", engine: "ai" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const result = await explainWord({ word: "Hund", context: "", from: "de", to: "pl" });
    assert.equal(result.explanation, "Awaryjna odpowiedź.");
    assert.equal(result.cached, false);
    assert.equal(calls, 2);
    clearExplanationCache();
  });
});
