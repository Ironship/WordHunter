// Simple translation system. Locale in `i18n/<code>.json`. Dot-separated keys → path.
import { APP_LOCALES } from "./constants.js";
import { fetchWithTimeout } from "./request.js";

const SUPPORTED = APP_LOCALES;
const FALLBACK = "en";

let currentLocale = FALLBACK;
export type TranslationVariables = Readonly<Record<string, unknown>>;
type TranslationDictionary = Record<string, unknown>;

let dict: TranslationDictionary = {};

// Monotonic load sequence. The boot locale choice (#275) can race the bridge
// snapshot: the app boots against navigator.language, then the persisted
// locale arrives and must win even when its fetch is slower than the boot
// fetch. A stale response (an older load resolving last) would otherwise
// overwrite the newer dictionary — only the newest request applies its dict.
let loadRequestSeq = 0;

export function getLocale() {
  return currentLocale;
}

/**
 * First-launch locale (issue #135): the saved preference wins, else the
 * browser/OS language (matched against the shipped locales by `loadLocale`),
 * else Polish — the app's default locale when the system locale is unknown.
 */
export function initialLocale(savedLocale?: string, navigatorLanguage?: string): string {
  if (savedLocale) return savedLocale;
  const nav = (navigatorLanguage || "").split("-")[0];
  return nav || "pl";
}

export async function loadLocale(locale: string) {
  const code = SUPPORTED.includes(locale) ? locale : FALLBACK;
  const seq = ++loadRequestSeq;
  try {
    const response = await fetchWithTimeout(`i18n/${code}.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const nextDict = await response.json();
    // A newer loadLocale has started since this fetch began — its dictionary
    // supersedes this one, so do not apply a stale translation set.
    if (seq !== loadRequestSeq) return;
    dict = nextDict;
    currentLocale = code;
    document.documentElement.lang = code;
  } catch (error) {
    console.warn("Failed to load translations:", error);
    if (seq !== loadRequestSeq) return;
    if (code !== FALLBACK) await loadLocale(FALLBACK);
  }
}

export function t(key: string, vars?: TranslationVariables) {
  return tWithDict(dict, key, vars);
}

export function tWithDict(dict: TranslationDictionary, key: string, vars?: TranslationVariables) {
  const value = key.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as TranslationDictionary)[part] : undefined),
    dict
  );
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

/**
 * Plural-aware translation (issue #268). The dictionary carries suffixed
 * variants of count-bearing keys — `<key>_zero`, `<key>_one`, `<key>_few`,
 * `<key>_many`, `<key>_other` — and the category is chosen by
 * `Intl.PluralRules` for the active locale (EN needs one/other, PL/RU/UK
 * need one/few/many/other). A missing suffixed variant falls back to the
 * plain `<key>`, so locales without a given form keep working.
 */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

let pluralRules: Intl.PluralRules | null = null;
let pluralRulesLocale = "";

export function selectPluralCategory(count: number, locale = currentLocale): PluralCategory {
  if (typeof Intl === "undefined" || typeof Intl.PluralRules !== "function") {
    return count === 1 ? "one" : "other";
  }
  if (pluralRulesLocale !== locale) {
    try {
      pluralRules = new Intl.PluralRules(locale);
      pluralRulesLocale = locale;
    } catch {
      pluralRules = null;
      pluralRulesLocale = "";
    }
  }
  if (pluralRules) {
    try {
      const category = pluralRules.select(count) as PluralCategory;
      if (category) return category;
    } catch {
      // Fall through to the English-like approximation.
    }
  }
  return count === 1 ? "one" : "other";
}

export function plural(baseKey: string, count: number, vars?: TranslationVariables) {
  return pluralWithDict(dict, baseKey, count, vars);
}

export function pluralWithDict(
  dict: TranslationDictionary,
  baseKey: string,
  count: number,
  vars?: TranslationVariables,
  locale = currentLocale
) {
  const pluralKey = `${baseKey}_${selectPluralCategory(count, locale)}`;
  const value = tWithDict(dict, pluralKey, vars);
  return value !== pluralKey ? value : tWithDict(dict, baseKey, vars);
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
