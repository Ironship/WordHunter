import { state, saveState, createDefaultState, normalizeState, replaceState, resetInitialVocabKeys, clearLastReadTextForLanguage } from "./state.js";
import { STORAGE_KEY } from "./constants.js";
import { buildSavePayload } from "./api.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { getVocabularyTextById, loadTextVocabularyIndex } from "./text-vocab.js";
import { VOCAB_STATUS_FILTERS } from "./events/vocab-status.js";

const WH_TOKEN_HEADER = { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" };

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

async function requestVocabExport(payload) {
  if (!window.__qtBridge) {
    throw new Error("vocab export requires native bridge");
  }
  const response = await fetch("/__vocab", {
    method: "POST",
    headers: WH_TOKEN_HEADER,
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`vocab_export HTTP ${response.status}`);
  return response.json();
}

async function requestAnkiImport(tsv) {
  if (!window.__qtBridge) {
    throw new Error("anki import requires native bridge");
  }
  const response = await fetch("/__vocab", {
    method: "POST",
    headers: WH_TOKEN_HEADER,
    body: JSON.stringify({ op: "import", tsv })
  });
  if (!response.ok) throw new Error(`vocab_import HTTP ${response.status}`);
  return response.json();
}

function safeFilenamePart(value) {
  return String(value || "text")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "text";
}

function getSelectedVocabStatusesForExport() {
  if (Array.isArray(state.filters?.vocabStatuses)) {
    return state.filters.vocabStatuses.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  }
  return [...VOCAB_STATUS_FILTERS];
}

async function loadTextIndexForExport(textId) {
  if (textId === "all") return null;
  const index = await loadTextVocabularyIndex(textId);
  if (!index) return null;
  return {
    words: Array.from(index.words),
    tokenLine: index.tokenLine
  };
}

function exportRequestBase(filename, format) {
  return {
    op: "export",
    vocab: state.vocab || {},
    query: state.filters?.vocabQuery || "",
    statuses: getSelectedVocabStatusesForExport(),
    textIndex: null,
    format,
    filename,
    headerRow: format === "anki" ? t("settings.ankiTsvHeader") : undefined,
    lang: state.preferences?.learningLanguage || "en",
    algorithm: state.preferences?.wordDetectionAlgorithm || "modern"
  };
}

export async function exportVocabularySelection(format) {
  const textId = state.filters?.vocabTextId || "all";
  const text = textId === "all" ? null : getVocabularyTextById(textId);
  const sourcePart = safeFilenamePart(text?.title || "filtered");
  const datePart = new Date().toISOString().slice(0, 10);
  const suffix = format === "anki" ? "anki" : "words";
  const ext = format === "anki" ? "tsv" : "txt";
  const filename = `wordhunter-${sourcePart}-${suffix}-${datePart}.${ext}`;

  const payload = exportRequestBase(filename, format);
  try {
    payload.textIndex = await loadTextIndexForExport(textId);
    const result = await requestVocabExport(payload);
    if (!result.count) {
      showToast(t("toast.vocabExportEmpty"));
      return;
    }
    await nativeSave(result.content, result.filename, result.mime);
    showToast(t("toast.exportReady"));
  } catch (error) {
    console.warn("vocab_export failed", error);
    showToast(t("toast.importFailed"));
  }
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
          body: JSON.stringify(buildSavePayload(state))
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
  const removedTextIds = state.customTexts.map((text) => text.id);
  if (window.__qtBridge) {
    removedTextIds.forEach((id) => {
      fetch("/__store/delete_text", {
        method: "POST",
        headers: WH_TOKEN_HEADER,
        body: JSON.stringify({ id })
      }).catch((error) => console.warn("clear library text delete failed", error));
    });
  }
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
  const datePart = new Date().toISOString().slice(0, 10);
  const filename = `vocab-anki-${datePart}.tsv`;
  const payload = {
    op: "export",
    vocab: state.vocab || {},
    query: "",
    statuses: selectedStatuses.filter((s) => VOCAB_STATUS_FILTERS.includes(s)),
    textIndex: null,
    format: "anki",
    filename,
    headerRow: t("settings.ankiTsvHeader"),
    lang: state.preferences?.learningLanguage || "en",
    algorithm: state.preferences?.wordDetectionAlgorithm || "modern"
  };
  try {
    const result = await requestVocabExport(payload);
    if (!result.count) {
      showToast(t("toast.ankiExportEmpty"));
      return;
    }
    await nativeSave(result.content, result.filename, result.mime);
    showToast(t("toast.exportReady"));
  } catch (error) {
    console.warn("anki export failed", error);
  }
}

export function importAnkiTsv(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", async () => {
    try {
      const text = String(reader.result || "");
      let rows;
      if (window.__qtBridge) {
        const result = await requestAnkiImport(text);
        rows = result.rows || [];
      } else {
        rows = parseAnkiTsvLocally(text);
      }
      let importedCount = 0;
      for (const row of rows) {
        const word = row.word;
        if (!word) continue;
        const entry = getOrCreateEntry(word, row.context);
        if (row.translation) entry.translation = row.translation;
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

function parseAnkiTsvLocally(text) {
  const rows = [];
  let hasHeader = false;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    const parts = trimmed.split("\t");
    if (!hasHeader && parts[0]?.trim().toLowerCase() === "word") {
      hasHeader = true;
      continue;
    }
    const word = parts[0]?.trim();
    if (!word) continue;
    rows.push({
      word,
      translation: parts[1]?.trim() || "",
      context: parts[2]?.trim() || ""
    });
  }
  return rows;
}
