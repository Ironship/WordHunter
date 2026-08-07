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
  formatAiExplanation,
  hasWordExplanation,
  markWordExplained
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
        aiExplanationModel: "deepseek-v4-flash",
        aiExplanationEffort: ""
      }
    });
  });

  it("normalizes text preferences with defaults", () => {
    assert.equal(normalizeAiTextPreference("aiExplanationEndpoint", ""), DEFAULT_AI_ENDPOINT);
    assert.equal(normalizeAiTextPreference("aiExplanationEndpoint", "  https://example.com/v1/chat/completions  "), "https://example.com/v1/chat/completions");
    assert.equal(normalizeAiTextPreference("aiExplanationModel", ""), DEFAULT_AI_MODEL);
    assert.equal(normalizeAiTextPreference("aiExplanationModel", "  my-model  "), "my-model");
    assert.equal(normalizeAiTextPreference("aiExplanationApiKey", "  abc  "), "abc");
    assert.equal(normalizeAiTextPreference("aiExplanationEffort", "  high  "), "high");
    assert.equal(normalizeAiTextPreference("aiExplanationEffort", ""), "");
    assert.equal(normalizeAiTextPreference("aiExplanationEffort", "ultra"), "", "unknown effort levels are dropped");
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
    assert.equal(body.effort, "", "effort defaults to empty (do not send)");
    assert.equal(body.image, undefined);
    assert.equal(body.rect, undefined);
  });

  it("sends the chosen effort level", async () => {
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, json: async () => ({ explanation: "ok", engine: "ai" }) };
    };
    state.preferences.aiExplanationEffort = "max";

    await requestAiExplanation({ word: "run", context: "", from: "en", to: "pl" });
    assert.equal(captured.effort, "max");
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

  it("renders italic, inline code and headings safely", () => {
    const html = formatAiExplanation(
      "### Czasownik\n\nTo jest *kursywa* i **pogrubienie** oraz `kod <x>`.\n\n# Nagłówek z *emfazą*"
    );
    assert.equal(
      html,
      '<p class="ai-heading"><strong>Czasownik</strong></p>' +
        "<p>To jest <em>kursywa</em> i <strong>pogrubienie</strong> oraz <code>kod &lt;x&gt;</code>.</p>" +
        '<p class="ai-heading"><strong>Nagłówek z <em>emfazą</em></strong></p>'
    );
  });

  it("renders bullet and numbered lists", () => {
    const html = formatAiExplanation(
      "Znaczenia:\n- pierwsze znaczenie z **boldem**\n- drugie znaczenie\n\nKroki:\n1. zrób to\n2. zrób tamto"
    );
    assert.equal(
      html,
      "<p>Znaczenia:</p>" +
        "<ul><li>pierwsze znaczenie z <strong>boldem</strong></li><li>drugie znaczenie</li></ul>" +
        "<p>Kroki:</p>" +
        "<ol><li>zrób to</li><li>zrób tamto</li></ol>"
    );
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

  it("remembers which words have been explained (auto-trigger set)", async () => {
    globalThis.localStorage = workingLocalStorage();
    assert.equal(hasWordExplanation("Hund"), false, "unknown words are unexplained");
    markWordExplained("Hund");
    assert.equal(hasWordExplanation("Hund"), true);
    markWordExplained("Hund");
    assert.equal(hasWordExplanation("Hund"), true, "marking twice must not corrupt the set");
    assert.equal(hasWordExplanation("Katze"), false);
    // Survives a reload (persisted in localStorage)
    const reloaded = JSON.parse(globalThis.localStorage.getItem("wh-ai-explained-words-v1"));
    assert.deepEqual(reloaded, ["Hund"]);
  });

  it("falls back to \"unexplained\" when storage is unavailable", async () => {
    globalThis.localStorage = null;
    try {
      assert.equal(hasWordExplanation("Hund"), false);
      markWordExplained("Hund");
      assert.equal(hasWordExplanation("Hund"), false, "no storage => word stays unexplained");
    } finally {
      globalThis.localStorage = workingLocalStorage();
    }
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

  it("keeps effort and endpoint in the cache key", async () => {
    globalThis.localStorage = workingLocalStorage();
    clearExplanationCache();
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"Odpowiedź\"}}]}\n\n",
        "data: [DONE]\n\n"
      ]);
    };

    // Same word/context, different effort => different cache key
    const first = await explainWord({ word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" });
    assert.equal(first.cached, false);
    state.preferences.aiExplanationEffort = "high";
    const second = await explainWord({ word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" });
    assert.equal(second.cached, false, "effort must be part of the cache key");
    assert.equal(fetchCount, 2);
    state.preferences.aiExplanationEffort = "";

    // Same word/context, different endpoint => different cache key
    state.preferences.aiExplanationEndpoint = "https://other.example.com/v1/chat/completions";
    const otherEndpoint = await explainWord({ word: "Hund", context: "Der Hund bellt.", from: "de", to: "pl" });
    assert.equal(otherEndpoint.cached, false, "endpoint must be part of the cache key");
    assert.equal(fetchCount, 3);
    state.preferences.aiExplanationEndpoint = "https://opencode.ai/zen/go/v1/chat/completions";

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
