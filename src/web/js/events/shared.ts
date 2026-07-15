// Shared helpers used by both events.js barrel and navigation.js submodule.
import { state } from "../state.js";
import { t } from "../i18n.js";
import { getReaderSelectionText } from "../reader/selection.js";
import { showToast } from "../toast.js";
import { isAndroidPlatform, openAndroidUrl } from "../platform.js";
import { resolveTheme } from "../theme.js";
import { resolveProfileTranslationPair } from "../translator-preferences.js";
import { formatHeadword } from "../vocabulary/article.js";

export function hasNativeTextSelection(): boolean {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

export function getSelectedReaderActionText(includeArticle = false): string {
  const selection = getReaderSelectionText();
  if (selection) return selection;
  const word = state.selectedWord || "";
  return includeArticle ? formatHeadword(word, state.vocab?.[word]?.article) : word;
}

export async function openDictionary(word: string): Promise<void> {
  if (!isAndroidPlatform() && state.preferences?.argosAsDict && state.preferences?.offlineTranslator) {
    const { fromCode: fromLang, toCode: toLang, configured } = resolveProfileTranslationPair(state.preferences);
    if (!configured) {
      showToast(t("translator.providerUnavailable"), "error");
      return;
    }
    const theme = resolveTheme(state.preferences.theme, document.documentElement.dataset.theme === "dark");
    const locale = state.preferences.locale || "pl";
    const url = `/__argos/ui?text=${encodeURIComponent(word || "")}&from=${fromLang}&to=${toLang}&theme=${theme.mode}&family=${theme.family}&locale=${locale}`;
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

export async function copySelectedWordToClipboard(): Promise<void> {
  const word = getSelectedReaderActionText();
  if (!word) return;
  try {
    await navigator.clipboard.writeText(word);
  } catch (error) {
    const textarea = document.createElement("textarea");
    try {
      textarea.value = word;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("copy command rejected");
    } catch (fallbackError) {
      console.warn("Could not copy selected word", fallbackError);
      showToast(t("toast.copyFailed"), "error");
      return;
    } finally {
      textarea.remove();
    }
  }
  showToast(t("toast.wordCopied", { word }));
}
