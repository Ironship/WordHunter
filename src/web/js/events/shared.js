// Shared helpers used by both events.js barrel and navigation.js submodule.
import { state } from "../state.js";
import { t } from "../i18n.js";
import { getReaderSelectionText } from "../views/reader.js";
import { showToast } from "../toast.js";
import { openAndroidUrl } from "../platform.js";

export function hasNativeTextSelection() {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

export function getSelectedReaderActionText() {
  return getReaderSelectionText() || state.selectedWord || "";
}

export async function openDictionary(word) {
  if (state.preferences?.argosAsDict && state.preferences?.offlineTranslator) {
    const fromLang = state.preferences.learningLanguage || "en";
    const toLang = state.preferences.locale || "pl";
    const theme = state.preferences.theme || "auto";
    const locale = state.preferences.locale || "pl";
    const url = `/__argos/ui?text=${encodeURIComponent(word || "")}&from=${fromLang}&to=${toLang}&theme=${theme}&locale=${locale}`;
    const dictUrl = `/__open_dict?url=${encodeURIComponent(url)}&mode=internal&title=${encodeURIComponent(t("translator.argosTitle"))}`;
    fetch(dictUrl).catch(e => console.warn("Failed to open offline translator UI", e));
    return;
  }

  if (!word) return;
  let url = state.preferences.dictionaryUrl || "https://www.diki.pl/slownik-angielskiego?q={{word}}";
  url = url.replace("{{word}}", encodeURIComponent(word));
  const mode = state.preferences.dictionaryMode || "internal";

  if (openAndroidUrl(url)) return;
  if (window.__qtBridge) {
    fetch("/__open_dict?url=" + encodeURIComponent(url) + "&mode=" + encodeURIComponent(mode))
      .catch(e => console.warn("Failed to open dictionary", e));
  } else {
    window.open(url, "_blank");
  }
}

export async function copySelectedWordToClipboard() {
  const word = getSelectedReaderActionText();
  if (!word) return;
  try {
    await navigator.clipboard.writeText(word);
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = word;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast(t("toast.wordCopied", { word }));
}
