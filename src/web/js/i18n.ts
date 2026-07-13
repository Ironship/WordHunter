// Simple translation system. Locale in `i18n/<code>.json`. Dot-separated keys → path.
import { APP_LOCALES } from "./constants.js";

const SUPPORTED = APP_LOCALES;
const FALLBACK = "en";

let currentLocale = FALLBACK;
export type TranslationVariables = Readonly<Record<string, unknown>>;
type TranslationDictionary = Record<string, unknown>;

let dict: TranslationDictionary = {};

export function getLocale() {
  return currentLocale;
}

export async function loadLocale(locale: string) {
  const code = SUPPORTED.includes(locale) ? locale : FALLBACK;
  try {
    const response = await fetch(`i18n/${code}.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dict = await response.json();
    currentLocale = code;
    document.documentElement.lang = code;
  } catch (error) {
    console.warn("Failed to load translations:", error);
    if (code !== FALLBACK) await loadLocale(FALLBACK);
  }
}

export function t(key: string, vars?: TranslationVariables) {
  const value = key.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as TranslationDictionary)[part] : undefined),
    dict
  );
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

// Applies translations to static HTML. Attributes:
//   data-i18n="key"            → textContent
//   data-i18n-html="key"       → innerHTML (be careful with trusted content in localization)
//   data-i18n-attr="placeholder=key,title=other.key"
export function applyTranslations(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    el.dataset.i18nAttr.split(",").forEach((pair) => {
      const [attr, key] = pair.split("=").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}
