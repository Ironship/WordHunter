import { httpPost } from "./http.js";

const MAX_VISIBLE_MODELS = 80;
const AI_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Android IMEs sometimes report Enter as keyCode 13 with an unidentified key. */
export function isAiModelCommitKey(event: Pick<KeyboardEvent, "key" | "keyCode">): boolean {
  return event.key === "Enter" || event.keyCode === 13;
}

export interface AiModelCache {
  endpoint: string;
  models: string[];
  fetchedAt: number;
}

function normalizeModelIds(values: unknown[]): string[] {
  const ids = values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((id) => id.length > 0 && id.length <= 300);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Convert an OpenAI-compatible `{ data: [{ id }] }` response to model ids. */
export function normalizeAiModels(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return "";
      return typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id.trim()
        : "";
    });
  return normalizeModelIds(ids);
}

export function getCachedAiModels(cache: unknown, endpoint: string): string[] {
  if (!cache || typeof cache !== "object") return [];
  const candidate = cache as Partial<AiModelCache>;
  if (candidate.endpoint !== endpoint.trim() || !Array.isArray(candidate.models)) return [];
  return normalizeModelIds(candidate.models);
}

export function isAiModelCacheFresh(
  cache: unknown,
  endpoint: string,
  now = Date.now()
): boolean {
  if (!getCachedAiModels(cache, endpoint).length || !cache || typeof cache !== "object") return false;
  const fetchedAt = Number((cache as Partial<AiModelCache>).fetchedAt);
  return Number.isFinite(fetchedAt)
    && fetchedAt <= now
    && now - fetchedAt <= AI_MODELS_CACHE_TTL_MS;
}

/** Fetch the provider's model catalog through WordHunter's local backend. */
export async function requestAiModels(
  endpoint: string,
  apiKey: string,
  callerSignal?: AbortSignal
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15000);
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await httpPost("/__ai/models", { endpoint: endpoint.trim(), apiKey: apiKey.trim() }, { signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const models = normalizeAiModels(await response.json());
    if (!models.length) throw new Error("AI endpoint returned no models");
    return models;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function aiModelSearchPhrases(query: string): string[] {
  return String(query || "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function aiModelMatches(model: string, phrases: string[]): boolean {
  const haystack = model.toLocaleLowerCase();
  return phrases.every((phrase) => haystack.includes(phrase));
}

export function countAiModelMatches(models: string[], query: string): number {
  const phrases = aiModelSearchPhrases(query);
  return models.filter((model) => aiModelMatches(model, phrases)).length;
}

/** Filter model identifiers by every whitespace-separated search phrase. */
export function filterAiModels(models: string[], query: string, limit = MAX_VISIBLE_MODELS): string[] {
  const phrases = aiModelSearchPhrases(query);
  return models
    .filter((model) => aiModelMatches(model, phrases))
    .slice(0, Math.max(0, limit));
}
