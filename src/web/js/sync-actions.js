import { state, saveState, createDefaultState, normalizeState, replaceState, resetInitialVocabKeys, clearLastReadTextForLanguage } from "./state.js";
import { STORAGE_KEY } from "./constants.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { normalizeSearchVariants } from "./tokenizer_v2.js";
import { entryAppearsInText, getTextVocabularyIndex, getVocabularyTextById } from "./text-vocab.js";

const VOCAB_STATUS_FILTERS = ["new", "learning", "known", "ignored"];

async function nativeSave(data, filename, mime) {
  if (window.__qtBridge) {
    await fetch("/__export/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ data, filename, mime })
    });
  } else {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function safeFilenamePart(value) {
  return String(value || "text")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "text";
}

function cleanExportCell(value) {
  return String(value || "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function getSelectedVocabStatusesForExport() {
  if (Array.isArray(state.filters?.vocabStatuses)) {
    return state.filters.vocabStatuses.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  }
  return [...VOCAB_STATUS_FILTERS];
}

function getFilteredVocabularyEntriesForExport() {
  const query = state.filters?.vocabQuery || "";
  const queryVariants = normalizeSearchVariants(query);
  const statusFilters = new Set(getSelectedVocabStatusesForExport());
  const textId = state.filters?.vocabTextId || "all";
  const textIndex = textId === "all" ? null : getTextVocabularyIndex(textId);

  return Object.entries(state.vocab || {})
    .map(([word, entry]) => ({ word, ...entry }))
    .filter((entry) => {
      if (!statusFilters.has(entry.status || "new")) return false;
      if (textIndex && !entryAppearsInText(entry.word, textIndex)) return false;
      if (!query) return true;
      const haystackText = `${entry.word} ${entry.translation || ""} ${entry.note || ""}`;
      const haystacks = normalizeSearchVariants(haystackText);
      return queryVariants.some((q) => haystacks.some((h) => h.includes(q)));
    })
    .sort((first, second) => first.word.localeCompare(second.word, undefined, { sensitivity: "base" }));
}

export async function exportVocabularySelection(format) {
  const entries = getFilteredVocabularyEntriesForExport();
  if (!entries.length) {
    showToast(t("toast.vocabExportEmpty"));
    return;
  }

  const textId = state.filters?.vocabTextId || "all";
  const text = textId === "all" ? null : getVocabularyTextById(textId);
  const sourcePart = safeFilenamePart(text?.title || "filtered");
  const datePart = new Date().toISOString().slice(0, 10);

  if (format === "anki") {
    let tsv = t("settings.ankiTsvHeader");
    for (const entry of entries) {
      const context = entry.examples?.[0] || entry.note || "";
      tsv += `${cleanExportCell(entry.word)}\t${cleanExportCell(entry.translation)}\t${cleanExportCell(context)}\n`;
    }
    await nativeSave(tsv, `wordhunter-${sourcePart}-anki-${datePart}.tsv`, "text/tab-separated-values");
    showToast(t("toast.exportReady"));
    return;
  }

  const body = `${entries.map((entry) => cleanExportCell(entry.word)).join("\n")}\n`;
  await nativeSave(body, `wordhunter-${sourcePart}-words-${datePart}.txt`, "text/plain;charset=utf-8");
  showToast(t("toast.exportReady"));
}

export async function exportState() {
  const payload = JSON.stringify(state, null, 2);
  const filename = `wordhunter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  await nativeSave(payload, filename, "application/json");
  showToast(t("toast.exportReady"));
}

export function importStateFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    showToast(t("toast.fileError"));
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const raw = String(reader.result || "{}");
      const parsed = JSON.parse(raw);
      const preview = {
        words: Object.keys(parsed.vocab || {}).length,
        texts: (parsed.customTexts || []).length,
        profiles: Object.keys(parsed.profiles || {}).length
      };
      const msg = t("sync.importConfirm", { words: preview.words, texts: preview.texts, profiles: preview.profiles });
      if (!window.confirm(msg)) {
        event.target.value = "";
        return;
      }

      const imported = normalizeState({ ...createDefaultState(), ...parsed });
      replaceState(imported);
      ensureCurrentText();
      
      if (window.__qtBridge) {
        fetch("/__store/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
          body: JSON.stringify({
            texts: state.customTexts || [],
            prefs: { ...(state.preferences || {}), __userBooks: state.userBooks || [] },
            hiddenBooks: state.hiddenBuiltInBooks || [],
            vocab: state.profiles || {}
          })
        }).catch(e => console.warn("bridge save state file failed", e));
      } else {
        saveState();
      }
      
      render();
      showToast(t("toast.importDone"));
    } catch (error) {
      console.warn(error);
      showToast(t("toast.importFailed"));
    }
  });
  reader.readAsText(file);
  event.target.value = "";
}

export function clearWords() {
  const confirmed = window.confirm(t("toast.confirmClearWords"));
  if (!confirmed) return;
  const lang = state.preferences?.learningLanguage || "de";
  state.vocab = {};
  if (state.profiles?.[lang]) {
    state.profiles[lang].vocab = state.vocab;
  }
  state.selectedWord = null;
  state.reviewIndex = 0;
  resetInitialVocabKeys();
  hideReviewAnswer();
  saveState();
  render();
  showToast(t("toast.dataCleared"));
}

export function clearLibrary() {
  const confirmed = window.confirm(t("toast.confirmClearLibrary"));
  if (!confirmed) return;
  const lang = state.preferences?.learningLanguage || "de";
  state.customTexts = [];
  state.userBooks = [];
  state.hiddenBuiltInBooks = [];
  state.archivedBookIds = [];
  state.currentTextId = null;
  clearLastReadTextForLanguage(lang);
  state.readerPage = 1;
  state.readerPages = {};
  state.readerScrolls = {};
  if (state.profiles?.[lang]) {
    state.profiles[lang].customTexts = state.customTexts;
    state.profiles[lang].userBooks = state.userBooks;
    state.profiles[lang].hiddenBuiltInBooks = state.hiddenBuiltInBooks;
    state.profiles[lang].archivedBookIds = state.archivedBookIds;
  }
  saveState();
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export function clearLocalState() {
  const confirmed = window.confirm(t("toast.confirmClear"));
  if (!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  replaceState(createDefaultState());
  
  if (window.__qtBridge) {
    fetch("/__store/wipe", { 
      method: "POST",
      headers: { "X-WH-Token": window.WH_TOKEN || "" }
    }).catch(e => console.warn("wipe failed", e));
  } else {
    saveState();
  }
  
  hideReviewAnswer();
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export async function exportAnkiTsv() {
  const selectedStatuses = Array.isArray(state.preferences?.ankiExportStatuses) && state.preferences.ankiExportStatuses.length
    ? state.preferences.ankiExportStatuses
    : ["learning"];
  const exportStatuses = new Set(selectedStatuses);
  const entries = Object.entries(state.vocab)
    .filter(([, entry]) => exportStatuses.has(entry?.status || "new"));

  if (!entries.length) {
    showToast(t("toast.ankiExportEmpty"));
    return;
  }

  let tsv = t("settings.ankiTsvHeader");
  for (const [word, entry] of entries) {
    const translation = entry.translation || "";
    const context = entry.examples?.[0] || entry.note || "";
    const cleanWord = word.replace(/\t/g, " ").replace(/\n/g, " ");
    const cleanTrans = translation.replace(/\t/g, " ").replace(/\n/g, " ");
    const cleanCtx = context.replace(/\t/g, " ").replace(/\n/g, " ");
    tsv += `${cleanWord}\t${cleanTrans}\t${cleanCtx}\n`;
  }
  const filename = `vocab-anki-${new Date().toISOString().slice(0, 10)}.tsv`;
  await nativeSave(tsv, filename, "text/tab-separated-values");
  showToast(t("toast.exportReady"));
}

export function importAnkiTsv(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const text = String(reader.result || "");
      const lines = text.split("\n");
      let importedCount = 0;
      let hasHeader = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (!hasHeader && parts[0].toLowerCase() === "word") {
          hasHeader = true;
          continue;
        }
        const word = parts[0]?.trim();
        const translation = parts[1]?.trim() || "";
        const context = parts[2]?.trim() || "";
        if (!word) continue;
        
        const entry = getOrCreateEntry(word, context);
        if (translation) entry.translation = translation;
        entry.updatedAt = new Date().toISOString();
        importedCount++;
      }
      
      saveState();
      render();
      showToast(t("toast.importDoneCount", { count: importedCount }));
    } catch (error) {
      console.warn(error);
      showToast(t("toast.importFailed"));
    }
  });
  reader.readAsText(file);
  event.target.value = "";
}
