import { state } from "./state.js";
import { normalizeTranslationLanguageCode, resolveProfileTranslationPair } from "./translator-preferences.js";

export function activeTranslationProvider() {
  const provider = state.preferences?.translationProvider || "google";
  return ["offline", "deepl", "google", "lmstudio"].includes(provider) ? provider : "google";
}

export function canUseTranslationProvider() {
  if (!resolveProfileTranslationPair(state.preferences).configured) return false;
  const provider = activeTranslationProvider();
  if (provider === "offline") return state.preferences?.offlineTranslator === true;
  if (provider === "deepl") return !!String(state.preferences?.deeplApiKey || "").trim();
  if (provider === "lmstudio") return !!String(state.preferences?.lmStudioModel || "").trim();
  return true;
}

export async function translateText(text, from, to) {
  const fromCode = normalizeTranslationLanguageCode(from);
  const toCode = normalizeTranslationLanguageCode(to);
  if (!fromCode || !toCode) throw new Error("Translation language pair is not configured");
  if (fromCode === toCode) return { translated: text, engine: "identity" };
  const provider = activeTranslationProvider();
  if (provider === "offline") {
    const params = new URLSearchParams({ text, from: fromCode, to: toCode });
    const response = await fetch(`/__argos/translate?${params.toString()}`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
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
  return response.json();
}
