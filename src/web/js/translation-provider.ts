import { state } from "./state.js";
import { t } from "./i18n.js";
import {
  normalizeTranslationLanguageCode,
  normalizeTranslationProvider,
  resolveProfileTranslationPair,
  type TranslationProvider
} from "./translator-preferences.js";

export interface TranslationResult {
  translated: string;
  engine?: string;
  [key: string]: unknown;
}

export function activeTranslationProvider(): TranslationProvider {
  const provider = state.preferences?.translationProvider || "google";
  return normalizeTranslationProvider(provider);
}

export function canUseTranslationProvider(): boolean {
  if (!resolveProfileTranslationPair(state.preferences).configured) return false;
  const provider = activeTranslationProvider();
  if (provider === "offline") return state.preferences?.offlineTranslator === true;
  if (provider === "deepl") return !!String(state.preferences?.deeplApiKey || "").trim();
  if (provider === "lmstudio") return !!String(state.preferences?.lmStudioModel || "").trim();
  return true;
}

// Delay before the single retry of a failed translation request (ms).
const TRANSLATE_RETRY_DELAY_MS = 1_200;

/**
 * Translates with a single retry after a short delay. Translation endpoints
 * (especially the unofficial Google one) throttle intermittently — a bare
 * failure is usually transient, so callers that need a reliable result
 * (auto-translate, sentence/context translation, the translator view)
 * should use this instead of translateText directly.
 */
export async function translateWithRetry(text: string, from: string, to: string): Promise<TranslationResult> {
  try {
    return await translateText(text, from, to);
  } catch (error) {
    console.warn("Translation failed, retrying once", error);
    await new Promise((resolve) => setTimeout(resolve, TRANSLATE_RETRY_DELAY_MS));
    return translateText(text, from, to);
  }
}

export class TranslationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/// Map known translation errors to localized strings. Unknown/backend
/// errors return "" — their detail belongs in the console, not in a
/// UI string (backend text is English-only today).
export function localizedTranslationError(error: unknown): string {
  if (error instanceof TranslationError && error.code === "pair-not-configured") {
    return t("translator.errorPairNotConfigured");
  }
  return "";
}

export async function translateText(text: string, from: string, to: string): Promise<TranslationResult> {
  const fromCode = normalizeTranslationLanguageCode(from);
  const toCode = normalizeTranslationLanguageCode(to);
  if (!fromCode || !toCode) throw new TranslationError("pair-not-configured", "Translation language pair is not configured");
  if (fromCode === toCode) return { translated: text, engine: "identity" };
  const provider = activeTranslationProvider();
  if (provider === "offline") {
    const params = new URLSearchParams({ text, from: fromCode, to: toCode });
    const response = await fetch(`/__argos/translate?${params.toString()}`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<TranslationResult>;
  }

  const response = await fetch("/__translate/external", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WH-Token": window.WH_TOKEN || ""
    },
    body: JSON.stringify({
      provider,
      text,
      from: fromCode,
      to: toCode,
      key: state.preferences?.deeplApiKey || "",
      endpoint: state.preferences?.lmStudioEndpoint || "http://127.0.0.1:1234/v1/chat/completions",
      model: state.preferences?.lmStudioModel || ""
    })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<TranslationResult>;
}
