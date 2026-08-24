import { state } from "./state.js";
import { saveStateAndReloadBridge, reloadBridgeSnapshot } from "./bridge-commit.js";
import { getOrCreateEntry } from "./views/vocabulary.js";
import { parseWordHunterWowSavedVariables, mergeWordHunterWowEntry } from "./wow-addon-format.js";
import { resolveVocabularyKey } from "./tokenizer_v2.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render } from "./render.js";
import { maybeAutoTranslateWord } from "./vocab-actions.js";
import { beginElementBusy } from "./loading.js";

const MAX_WOW_IMPORT_BYTES = 8 * 1024 * 1024;

interface FileInputTarget {
  files?: ArrayLike<File>;
  value: string;
}

function fileInputTarget(event: unknown): FileInputTarget | null {
  if (!event || typeof event !== "object") return null;
  const target = (event as { target?: unknown }).target;
  if (!target || typeof target !== "object" || typeof (target as FileInputTarget).value !== "string") return null;
  return target as FileInputTarget;
}

export function importWordHunterWow(event: unknown): void {
  const target = fileInputTarget(event);
  const file = target?.files?.[0];
  if (!file) return;
  if (Number(file.size) > MAX_WOW_IMPORT_BYTES) {
    showToast(t("toast.wowImportTooLarge"), "error");
    target.value = "";
    return;
  }
  if (state.preferences?.learningLanguage !== "de") {
    showToast(t("toast.wowImportGermanProfile"), "error");
    target.value = "";
    return;
  }

  const importLabel = document.getElementById("import-wordhunter-wow")?.closest<HTMLElement>(".file-button");
  const importLabelText = importLabel?.querySelector<HTMLElement>("span");
  const releaseBusy = beginElementBusy(importLabel, { disable: true });
  const updateProgress = (message: string) => {
    if (importLabelText) importLabelText.textContent = message;
  };
  let finished = false;
  const finishProgress = () => {
    if (finished) return;
    finished = true;
    releaseBusy();
    updateProgress(t("transfer.importWow"));
  };
  updateProgress(t("transfer.importingWow"));
  showToast(t("transfer.importingWow"));

  const reader = new FileReader();
  reader.addEventListener("load", async () => {
    try {
      if (state.preferences?.learningLanguage !== "de") {
        showToast(t("toast.wowImportGermanProfile"), "error");
        return;
      }
      const rows = parseWordHunterWowSavedVariables(String(reader.result || ""));
      let changed = 0;
      const translationKeys = new Set<string>();
      for (const row of rows) {
        const sourceContext = row.context && row.questTitle
          ? `[WoW: ${row.questTitle}] ${row.context}`
          : row.context;
        const key = resolveVocabularyKey(row.word, state.vocab, "de");
        const existedBeforeImport = Object.hasOwn(state.vocab, key);
        const entry = getOrCreateEntry(row.word);
        const before = JSON.stringify(entry);
        mergeWordHunterWowEntry(entry, row, existedBeforeImport);
        const examplesBefore = JSON.stringify(entry.examples || []);
        getOrCreateEntry(row.word, sourceContext);
        if (JSON.stringify(entry.examples || []) !== examplesBefore) entry.updatedAt = new Date().toISOString();
        if (JSON.stringify(entry) !== before) changed++;
        if (row.status !== "ignored" && !String(entry.translation || "").trim()) {
          translationKeys.add(key);
        }
      }
      await saveStateAndReloadBridge({ withSnapshot: true });
      render();
      const translationTotal = translationKeys.size;
      let translationCurrent = 0;
      for (const key of translationKeys) {
        if (state.preferences?.learningLanguage !== "de") break;
        translationCurrent++;
        updateProgress(t("transfer.translatingWow", {
          current: translationCurrent,
          total: translationTotal
        }));
        const entry = state.vocab[key];
        if (entry) await maybeAutoTranslateWord(key, entry);
      }
      showToast(t("toast.wowImportDone", { count: changed }));
    } catch (error) {
      console.warn("WordHunterWoW import failed", error);
      if (window.__qtBridge) {
        await reloadBridgeSnapshot().catch((reloadError) => {
          console.warn("WordHunterWoW import recovery reload failed", reloadError);
        });
      }
      showToast(t("toast.wowImportFailed"), "error");
    } finally {
      finishProgress();
    }
  });
  const readFailed = () => {
    finishProgress();
    showToast(t("toast.wowImportFailed"), "error");
  };
  reader.addEventListener("error", readFailed);
  reader.addEventListener("abort", readFailed);
  reader.readAsText(file);
  target.value = "";
}
