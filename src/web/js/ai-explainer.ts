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
import { httpPost } from "./http.js";

export const DEFAULT_AI_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const DEFAULT_AI_MODEL = "deepseek-v4-flash";

/** Reasoning-effort levels offered in settings; "" = do not send anything. */
const AI_EFFORT_LEVELS = ["", "minimal", "low", "medium", "high", "max"] as const;
export type AiEffortLevel = (typeof AI_EFFORT_LEVELS)[number];

export function normalizeAiTextPreference(key: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (key === "aiExplanationEndpoint") return text || DEFAULT_AI_ENDPOINT;
  if (key === "aiExplanationModel") return text || DEFAULT_AI_MODEL;
  if (key === "aiExplanationEffort") {
    return AI_EFFORT_LEVELS.includes(text as AiEffortLevel) ? text : "";
  }
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
  /** "explain" (default) explains the word; "stats" analyzes the data in `context`. */
  kind?: "explain" | "stats";
}

export interface AiExplanationResult {
  explanation: string;
  engine?: string;
}

export async function requestAiExplanation(request: AiExplanationRequest): Promise<AiExplanationResult> {
  const payload = buildAiPayload(request);
  // A silent endpoint must not hang the explain flow (or keep a word
  // "in flight" forever); 90s is generous for a local/remote LLM call.
  const response = await httpPost("/__ai/explain", payload, { timeoutMs: 90_000 });
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
    model: normalizeAiTextPreference("aiExplanationModel", preferences.aiExplanationModel),
    effort: normalizeAiTextPreference("aiExplanationEffort", preferences.aiExplanationEffort)
  };
  if (request.image) {
    payload.image = request.image;
    payload.rect = request.rect;
  }
  if (request.kind) payload.kind = request.kind;
  return payload;
}

interface StreamResult {
  explanation: string;
  streamed: boolean;
}

/** Parse one SSE `data:` payload into the content delta. */
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
  const response = await httpPost("/__ai/explain_stream", buildAiPayload(request), { timeoutMs: 90_000 });
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
    if (tail) {
      // Endpoints that ignore SSE may answer with a plain JSON error body;
      // that must never be persisted as an "explanation".
      if (tail.startsWith("{")) {
        try {
          const parsed = JSON.parse(tail) as { error?: unknown };
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // Surface a readable message: {"error":{"message":"..."}} or a string.
            const detail = parsed.error;
            const message =
              typeof detail === "object" && detail !== null
                ? (detail as { message?: unknown }).message
                : detail;
            throw new Error(message ? String(message) : "AI endpoint returned an error");
          }
        } catch (error) {
          if (error instanceof SyntaxError) return { explanation: tail, streamed: true };
          throw error;
        }
      }
      return { explanation: tail, streamed: true };
    }
    throw new Error("AI endpoint returned no explanation");
  }
  return { explanation, streamed: true };
}

// --- explanation cache ---

const EXPLANATION_CACHE_KEY = "wh-ai-explanation-cache-v1";

// Words that have already received an AI explanation at least once. Used by
// the auto-trigger setting ("explain new words automatically") so a word is
// only auto-explained when it genuinely never had an explanation. The set is
// independent of the explanation cache (which can be cleared/evicted).
const AI_EXPLAINED_WORDS_KEY = "wh-ai-explained-words-v1";
const AI_EXPLAINED_WORDS_MAX = 1000;

/**
 * The words that have received an AI explanation, persisted as a JSON array.
 * On first load (or when the stored value is corrupt) it is seeded from the
 * explanation cache keys, so words explained before the auto-trigger feature
 * existed are not re-explained (and their notes re-flooded) after an upgrade.
 */
function loadExplainedWords(): string[] {
  try {
    const raw = localStorage.getItem(AI_EXPLAINED_WORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Corrupt or unreadable: fall through and rebuild from the cache.
  }
  const seeded: string[] = [];
  try {
    for (const key of loadExplanationCache().keys()) {
      // Current keys are 7 fields: [model, effort, endpoint, from, to, word,
      // context] — word at index 5. Pre-upgrade keys had 5 fields
      // ([model, from, to, word, context]) with word at index 3; accept both
      // so words explained before the auto-trigger feature are not
      // re-explained once after the upgrade.
      const parts = key.split("\u0001");
      const word = parts[5] ?? (parts.length === 5 ? parts[3] : undefined);
      if (word && !seeded.includes(word)) seeded.push(word);
    }
    localStorage.setItem(AI_EXPLAINED_WORDS_KEY, JSON.stringify(seeded));
  } catch {
    // Storage unavailable: treat as empty; auto-trigger will simply retry.
  }
  return seeded;
}

/** True when this word has already been explained by AI at least once. */
export function hasWordExplanation(word: string): boolean {
  try {
    return loadExplainedWords().includes(word);
  } catch {
    return false;
  }
}

/** Remember that this word received an AI explanation. */
export function markWordExplained(word: string): void {
  try {
    const set = loadExplainedWords();
    if (set.includes(word)) return;
    if (set.length >= AI_EXPLAINED_WORDS_MAX) set.splice(0, set.length - AI_EXPLAINED_WORDS_MAX + 1);
    set.push(word);
    localStorage.setItem(AI_EXPLAINED_WORDS_KEY, JSON.stringify(set));
  } catch {
    // Storage unavailable: the auto-trigger simply treats the word as
    // unexplained on the next open. Never throw into the explain flow.
  }
}
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
  const effort = normalizeAiTextPreference("aiExplanationEffort", preferences.aiExplanationEffort);
  const endpoint = normalizeAiTextPreference("aiExplanationEndpoint", preferences.aiExplanationEndpoint);
  // Effort and endpoint change the answer, so they are part of the cache key —
  // a cached explanation must never be served (and auto-appended to a note)
  // for a different provider or reasoning level.
  return [model, effort, endpoint, request.from, request.to, request.word, request.context].join("\u0001");
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
 * The cache key is computed ONCE before the request and reused for storage —
 * changing effort/model mid-request must not store the response under the new
 * settings.
 */
export async function explainWord(
  request: AiExplanationRequest,
  onDelta?: (text: string) => void
): Promise<{ explanation: string; cached: boolean }> {
  const cacheKey = explanationCacheKey(request);
  const cached = loadExplanationCache().get(cacheKey);
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
  storeExplanation(cacheKey, explanation);
  return { explanation, cached: false };
}

/** Inline markdown on already-escaped text: code, bold, italic, line breaks. */
function renderInline(safe: string): string {
  // Protect code spans first so markdown inside them is not re-interpreted.
  const codeSpans: string[] = [];
  let text = safe.replace(/`([^`\n]+)`/gu, (_match, code: string) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/gu, "<em>$1</em>")
    .replace(/\n/gu, "<br>");
  return text.replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => `<code>${codeSpans[Number(index)]}</code>`);
}

/**
 * Render one paragraph block (no blank lines inside). Consecutive bullet
 * (`- `, `* `, `• `) and numbered (`1. `, `1) `) lines become lists; `#`
 * headings become a bold lead line; everything else stays a paragraph with
 * `<br>` line breaks, exactly like before.
 */
function renderBlock(block: string): string {
  const lines = block.split("\n");
  let html = "";
  let listType: "ul" | "ol" | null = null;
  let paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length) {
      html += `<p>${renderInline(escapeHtml(paragraphLines.join("\n")))}</p>`;
      paragraphLines = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/u);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/u);
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/u);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        html += `<${type}>`;
        listType = type;
      }
      html += `<li>${renderInline(escapeHtml((bullet || ordered)![1]))}</li>`;
    } else if (heading) {
      flushParagraph();
      closeList();
      html += `<p class="ai-heading"><strong>${renderInline(escapeHtml(heading[1]))}</strong></p>`;
    } else {
      closeList();
      paragraphLines.push(trimmed);
    }
  }
  flushParagraph();
  closeList();
  return html;
}

/** Format a raw model reply into safe HTML: paragraphs, **bold**, *italic*, `code`, lists. */
export function formatAiExplanation(text: string): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw
    .split(/\n{2,}/u)
    .map((block) => renderBlock(block))
    .join("");
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
