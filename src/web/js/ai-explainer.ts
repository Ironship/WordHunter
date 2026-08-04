/**
 * AI explanations: context-aware word and phrase explanations through any
 * OpenAI-compatible chat completions endpoint (local llama.cpp / LM Studio /
 * Ollama, or remote providers such as opencode.ai, OpenAI, DeepSeek, ...).
 *
 * The Rust backend (`/__ai/explain`) performs the HTTP call so the webview
 * never talks to the configured endpoint directly (no CORS, key stays in the
 * app's own preference store).
 */
import { state } from "./state.js";
import { getTextById } from "./reader/renderer.js";
import { findPdfSentenceRange, effectivePdfPageText, type PdfOcrPage } from "./reader/pdf-page-text.js";
import { escapeHtml } from "./utils.js";
import { effectiveLearningLanguage, resolveProfileTranslationPair } from "./translator-preferences.js";

export const DEFAULT_AI_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const DEFAULT_AI_MODEL = "deepseek-v4-flash";

export function normalizeAiTextPreference(key: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (key === "aiExplanationEndpoint") return text || DEFAULT_AI_ENDPOINT;
  if (key === "aiExplanationModel") return text || DEFAULT_AI_MODEL;
  return text;
}

export function aiExplanationConfigured(preferences: Partial<WhPreferences> = state.preferences): boolean {
  return preferences.aiExplanationsEnabled === true
    && !!String(preferences.aiExplanationModel || "").trim()
    && !!String(preferences.aiExplanationEndpoint || "").trim();
}

export interface AiExplanationRequest {
  word: string;
  context: string;
  from: string;
  to: string;
  image?: string;
  rect?: { x0: number; y0: number; x1: number; y1: number };
}

export interface AiExplanationResult {
  explanation: string;
  engine?: string;
}

export async function requestAiExplanation(request: AiExplanationRequest): Promise<AiExplanationResult> {
  const payload = buildAiPayload(request);
  const response = await fetch("/__ai/explain", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json() as Promise<AiExplanationResult>;
}

function buildAiPayload(request: AiExplanationRequest): Record<string, unknown> {
  const preferences: Partial<WhPreferences> = state.preferences || {};
  const payload: Record<string, unknown> = {
    word: request.word,
    context: request.context,
    from: request.from,
    to: request.to,
    endpoint: normalizeAiTextPreference("aiExplanationEndpoint", preferences.aiExplanationEndpoint),
    apiKey: String(preferences.aiExplanationApiKey || ""),
    model: normalizeAiTextPreference("aiExplanationModel", preferences.aiExplanationModel)
  };
  if (request.image) {
    payload.image = request.image;
    payload.rect = request.rect;
  }
  return payload;
}

interface StreamResult {
  explanation: string;
  streamed: boolean;
}

function sseDelta(data: string): string {
  if (data === "[DONE]") return "";
  const event = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string } }>;
    error?: unknown;
  };
  if (event.error) {
    throw new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
  }
  return event.choices?.[0]?.delta?.content || "";
}

/**
 * Stream an explanation from `/__ai/explain_stream` (SSE). When the endpoint
 * ignores the stream flag and answers with a plain JSON body instead, the
 * whole response is parsed and returned in one shot (`streamed: false`).
 */
export async function requestAiExplanationStream(
  request: AiExplanationRequest,
  onDelta?: (text: string) => void
): Promise<StreamResult> {
  const response = await fetch("/__ai/explain_stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify(buildAiPayload(request))
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const result = (await response.json()) as AiExplanationResult;
    return { explanation: result.explanation || "", streamed: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let explanation = "";
  let sawDelta = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      let delta: string;
      try {
        delta = sseDelta(data);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (!delta) continue;
      sawDelta = true;
      explanation += delta;
      onDelta?.(explanation);
    }
  }
  if (!sawDelta) {
    const tail = buffer.trim();
    if (tail) return { explanation: tail, streamed: true };
    throw new Error("AI endpoint returned no explanation");
  }
  return { explanation, streamed: true };
}

// --- explanation cache ---

const EXPLANATION_CACHE_KEY = "wh-ai-explanation-cache-v1";
const EXPLANATION_CACHE_MAX = 300;
let explanationCache: Map<string, string> | null = null;

function loadExplanationCache(): Map<string, string> {
  if (explanationCache) return explanationCache;
  explanationCache = new Map();
  try {
    const raw = localStorage.getItem(EXPLANATION_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        explanationCache = new Map(parsed.filter((entry) => Array.isArray(entry) && entry.length === 2));
      }
    }
  } catch (error) {
    console.warn("Failed to load AI explanation cache", error);
  }
  return explanationCache;
}

function storeExplanation(key: string, explanation: string): void {
  const cache = loadExplanationCache();
  cache.delete(key);
  cache.set(key, explanation);
  while (cache.size > EXPLANATION_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  try {
    localStorage.setItem(EXPLANATION_CACHE_KEY, JSON.stringify([...cache.entries()]));
  } catch (error) {
    console.warn("Failed to persist AI explanation cache", error);
  }
}

function explanationCacheKey(request: AiExplanationRequest): string {
  const preferences: Partial<WhPreferences> = state.preferences || {};
  const model = normalizeAiTextPreference("aiExplanationModel", preferences.aiExplanationModel);
  return [model, request.from, request.to, request.word, request.context].join("\u0001");
}

export function clearExplanationCache(): void {
  explanationCache = new Map();
  try {
    localStorage.removeItem(EXPLANATION_CACHE_KEY);
  } catch {
    // storage unavailable
  }
}

/**
 * Unified entry point: serves cached explanations instantly, otherwise streams
 * the answer (falling back to the non-streaming endpoint), then caches it.
 */
export async function explainWord(
  request: AiExplanationRequest,
  onDelta?: (text: string) => void
): Promise<{ explanation: string; cached: boolean }> {
  const key = explanationCacheKey(request);
  const cached = loadExplanationCache().get(key);
  if (cached) return { explanation: cached, cached: true };

  let explanation = "";
  try {
    const streamed = await requestAiExplanationStream(request, onDelta);
    explanation = streamed.explanation;
  } catch (error) {
    console.warn("AI explanation streaming failed, falling back", error);
    const result = await requestAiExplanation(request);
    explanation = result.explanation || "";
  }
  if (!explanation) throw new Error("AI endpoint returned no explanation");
  storeExplanation(key, explanation);
  return { explanation, cached: false };
}

/** Format a raw model reply into safe HTML: paragraphs plus **bold** spans. */
export function formatAiExplanation(text: string): string {
  const paragraphs = String(text || "").split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  return paragraphs.map((paragraph) => {
    const safe = escapeHtml(paragraph)
      .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/\n/gu, "<br>");
    return `<p>${safe}</p>`;
  }).join("");
}

interface PdfOcrImageContext {
  image: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  context: string;
}

function tokenStylePercent(token: HTMLElement, property: string): number | null {
  const raw = token.style.getPropertyValue(property);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * When the reader shows a scanned PDF-OCR page, collect the page image
 * (data URL) plus the selected word's normalized bounding box so a
 * vision-capable model can look at the actual printed text.
 */
export async function collectPdfOcrImageContext(): Promise<PdfOcrImageContext | null> {
  const current = getTextById(state.currentTextId);
  const pages = (current as (WhText & { pdfOcrPages?: PdfOcrPage[] }) | null | undefined)?.pdfOcrPages;
  const page = Array.isArray(pages) ? pages[Math.max(0, (state.readerPage || 1) - 1)] : undefined;
  if (!current || !page || !page.imageName) return null;

  const selected = document.querySelector<HTMLElement>(".word-token.selected");
  const left = selected ? tokenStylePercent(selected, "left") : null;
  const top = selected ? tokenStylePercent(selected, "top") : null;
  const width = selected ? tokenStylePercent(selected, "width") : null;
  const height = selected ? tokenStylePercent(selected, "height") : null;
  if (left === null || top === null || width === null || height === null) return null;

  const pageWordIndex = selected?.dataset.pdfPageWordIndex;
  const language = effectiveLearningLanguage(state.preferences);
  const pageText = effectivePdfPageText(page);
  let context = "";
  if (pageWordIndex !== undefined && pageWordIndex !== "") {
    const range = findPdfSentenceRange(pageText, Number(pageWordIndex), language, state.preferences.wordDetectionAlgorithm || "modern");
    if (range) context = pageText.slice(range.start, range.end).trim();
  }

  const url = `/__media?book=${encodeURIComponent(current.id)}&img=${encodeURIComponent(page.imageName)}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) return null;
  const blob = await response.blob();
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read page image"));
    reader.readAsDataURL(blob);
  });
  if (!image.startsWith("data:image/")) return null;

  return {
    image,
    rect: {
      x0: left / 100,
      y0: top / 100,
      x1: (left + width) / 100,
      y1: (top + height) / 100
    },
    context
  };
}

/** Language pair the explanation should be written in. */
export function aiExplanationLanguagePair(): { from: string; to: string } {
  const pair = resolveProfileTranslationPair(state.preferences);
  return { from: pair.fromCode || "en", to: pair.toCode || "en" };
}
