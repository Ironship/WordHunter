import { OTHER_PROFILE_ID } from "./constants.js";

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

export function normalizeTranslationLanguageCode(value) {
  const code = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  if (code === OTHER_PROFILE_ID || code === "auto") return "";
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code) ? code : "";
}

export function resolveProfileTranslationPair(preferences = {}) {
  const profile = String(preferences.learningLanguage || "").toLowerCase();
  const locale = normalizeTranslationLanguageCode(preferences.locale) || "en";
  if (profile !== OTHER_PROFILE_ID) {
    return {
      fromCode: normalizeTranslationLanguageCode(profile) || "en",
      toCode: locale,
      configured: true
    };
  }

  const fromCode = normalizeTranslationLanguageCode(preferences.translationSourceLanguage);
  const toCode = normalizeTranslationLanguageCode(preferences.translationTargetLanguage) || locale;
  return { fromCode, toCode, configured: Boolean(fromCode && toCode) };
}

export function effectiveLearningLanguage(preferences = {}) {
  return resolveProfileTranslationPair(preferences).fromCode || "en";
}
