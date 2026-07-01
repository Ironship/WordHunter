const TRANSLATION_PROVIDERS = ["offline", "deepl", "google", "lmstudio"];

export const DEFAULT_LM_STUDIO_ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";

export function normalizeTranslationProvider(provider) {
  return TRANSLATION_PROVIDERS.includes(provider) ? provider : "google";
}

export function isDesktopOnlyTranslationProvider(provider) {
  return provider === "offline" || provider === "lmstudio";
}

export function normalizeTranslatorTextPreference(key, value) {
  const text = String(value ?? "").trim();
  return key === "lmStudioEndpoint" ? text || DEFAULT_LM_STUDIO_ENDPOINT : text;
}
