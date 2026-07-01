import { state } from "./state.js";

export function activeTranslationProvider() {
  const provider = state.preferences?.translationProvider || "google";
  return ["offline", "deepl", "google", "lmstudio"].includes(provider) ? provider : "google";
}

export function canUseTranslationProvider() {
  const provider = activeTranslationProvider();
  if (provider === "offline") return state.preferences?.offlineTranslator === true;
  if (provider === "deepl") return !!String(state.preferences?.deeplApiKey || "").trim();
  if (provider === "lmstudio") return !!String(state.preferences?.lmStudioModel || "").trim();
  return true;
}

export async function translateText(text, from, to) {
  const provider = activeTranslationProvider();
  if (provider === "offline") {
    const params = new URLSearchParams({ text, from, to });
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
      from,
      to,
      key: state.preferences?.deeplApiKey || "",
      endpoint: state.preferences?.lmStudioEndpoint || "http://127.0.0.1:1234/v1/chat/completions",
      model: state.preferences?.lmStudioModel || ""
    })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
