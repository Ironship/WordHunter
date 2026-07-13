import { OTHER_PROFILE_ID } from "./constants.js";

export type TranslationProvider = "offline" | "deepl" | "google" | "lmstudio";

export interface TranslatorPreferences {
  learningLanguage?: unknown;
  locale?: unknown;
  translationSourceLanguage?: unknown;
  translationTargetLanguage?: unknown;
}

export interface TranslationLanguagePair {
  fromCode: string;
  toCode: string;
  configured: boolean;
}

const TRANSLATION_PROVIDERS: readonly TranslationProvider[] = ["offline", "deepl", "google", "lmstudio"];

export const DEFAULT_LM_STUDIO_ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";

export function normalizeTranslationProvider(provider: unknown): TranslationProvider {
  return TRANSLATION_PROVIDERS.includes(provider as TranslationProvider) ? provider as TranslationProvider : "google";
}

export function isDesktopOnlyTranslationProvider(provider: unknown): boolean {
  return provider === "offline" || provider === "lmstudio";
}

export function normalizeTranslatorTextPreference(key: string, value: unknown): string {
  const text = String(value ?? "").trim();
  return key === "lmStudioEndpoint" ? text || DEFAULT_LM_STUDIO_ENDPOINT : text;
}

export function normalizeTranslationLanguageCode(value: unknown): string {
  const code = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  if (code === OTHER_PROFILE_ID || code === "auto") return "";
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code) ? code : "";
}

export function resolveProfileTranslationPair(preferences: TranslatorPreferences = {}): TranslationLanguagePair {
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

export function effectiveLearningLanguage(preferences: TranslatorPreferences = {}): string {
  return resolveProfileTranslationPair(preferences).fromCode || "en";
}
