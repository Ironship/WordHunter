// Simple translation system. Locale in `i18n/<code>.json`. Dot-separated keys → path.
const SUPPORTED = ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"];
const FALLBACK = "en";

let currentLocale = FALLBACK;
let dict = {};

export function getLocale() {
  return currentLocale;
}

export async function loadLocale(locale) {
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

export function t(key, vars) {
  const value = key.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), dict);
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

// Applies translations to static HTML. Attributes:
//   data-i18n="key"            → textContent
//   data-i18n-html="key"       → innerHTML (be careful with trusted content in localization)
//   data-i18n-attr="placeholder=key,title=other.key"
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.dataset.i18nAttr.split(",").forEach((pair) => {
      const [attr, key] = pair.split("=").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}
