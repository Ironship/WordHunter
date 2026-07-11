import { applyBridgeSnapshotToState, state, saveState, createDefaultState, normalizeState, replaceState, resetInitialVocabKeys, runExclusiveStateWrite, clearLastReadTextForLanguage } from "./state.js";
import { STORAGE_KEY } from "./constants.js";
import { buildSavePayload } from "./api.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { getVocabularyTextById, loadTextVocabularyIndex } from "./text-vocab.js";
import { VOCAB_STATUS_FILTERS } from "./events/vocab-status.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "./bridge-commit.js";
import { deleteStoredText, loadBackendSnapshot, postStoreCommand } from "./store-bridge.js";
import { assertSupportedStateSchemaVersion } from "./state/normalize.js";
import { clearAllBookTextCaches, clearBookTextCache, loadAllBookTexts, loadAllCustomTextContents } from "./books.js";

const WH_TOKEN_HEADER = { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" };
const LAST_BACKUP_KEY = `${STORAGE_KEY}:last-backup`;

function createAndroidExportRequestId() {
  return `android-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function saveWithAndroidBridge(data, filename, mime) {
  if (typeof window.WordHunterAndroid?.saveExport !== "function") return null;
  return new Promise((resolve, reject) => {
    const requestId = createAndroidExportRequestId();
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-export", onResult);
      clearTimeout(timeout);
    };
    const onResult = (event) => {
      const detail = event.detail || {};
      if (detail.requestId !== requestId) return;
      if (detail.terminal === false) return;
      cleanup();
      if (detail.cancelled) {
        resolve(false);
      } else if (detail.success) {
        resolve(true);
      } else {
        reject(new Error(detail.error || detail.status || "android export failed"));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("android export timed out"));
    }, 130000);

    window.addEventListener("wordhunter:android-export", onResult);
    try {
      const started = window.WordHunterAndroid.saveExport(data, filename, mime, requestId);
      if (started === false) {
        cleanup();
        resolve(false);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function nativeSave(data, filename, mime) {
  const androidSaved = saveWithAndroidBridge(data, filename, mime);
  if (androidSaved) return androidSaved;
  if (window.__qtBridge) {
    const response = await fetch("/__export/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ data, filename, mime })
    });
    if (!response.ok) throw new Error(`export HTTP ${response.status}`);
    const result = await response.json().catch(() => ({ saved: true }));
    return result.saved !== false;
  } else {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  }
}

async function backupBeforeClear() {
  const payload = JSON.stringify(state, null, 2);
  localStorage.setItem(LAST_BACKUP_KEY, payload);
  const filename = `wordhunter-backup-before-clear-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    if (!await nativeSave(payload, filename, "application/json")) {
      showToast(t("toast.backupRequired"));
      return false;
    }
    showToast(t("toast.backupCreated"));
    return true;
  } catch (error) {
    console.warn("backup before clear failed", error);
    showToast(t("toast.backupRequired"));
    return false;
  }
}

export async function requestVocabExport(payload) {
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

async function applyBridgeCommandResult(result, previousView) {
  if (!window.__qtBridge) return;
  const snapshot = result?.snapshot || await loadBackendSnapshot();
  applyBridgeSnapshotToState(snapshot, { previousView });
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
  if (!index) throw new Error(`text vocabulary index unavailable: ${textId}`);
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

function hydrateImportedLibrary() {
  Promise.all([loadAllBookTexts(), loadAllCustomTextContents()])
    .then(() => render())
    .catch((error) => console.warn("Imported book hydration failed", error));
}

function renderImportedState() {
  ensureCurrentText();
  render();
  hydrateImportedLibrary();
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
    showToast(await nativeSave(result.content, result.filename, result.mime) ? t("toast.exportReady") : t("toast.exportCancelled"));
  } catch (error) {
    console.warn("vocab_export failed", error);
    showToast(t("toast.importFailed"));
  }
}

export async function exportState() {
  const payload = JSON.stringify(state, null, 2);
  const filename = `wordhunter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  showToast(await nativeSave(payload, filename, "application/json") ? t("toast.exportReady") : t("toast.exportCancelled"));
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
  reader.addEventListener("load", async () => {
    try {
      const raw = String(reader.result || "{}");
      const parsed = JSON.parse(raw);
      assertSupportedStateSchemaVersion(parsed, "import file");
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
      if (window.__qtBridge) {
        const previousView = state.currentView || "settings";
        await runExclusiveStateWrite(async () => {
          let result;
          try {
            const response = await fetch("/__store/save?snapshot=1", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
              body: JSON.stringify(buildSavePayload(imported))
            });
            if (!response.ok) throw new Error(`import save HTTP ${response.status}`);
            result = await response.json();
            if (!result?.snapshot) throw new Error("import save response is missing snapshot");
          } catch (saveError) {
            try {
              const snapshot = await loadBackendSnapshot();
              clearAllBookTextCaches();
              applyBridgeSnapshotToState(snapshot, { previousView });
              renderImportedState();
            } catch (reloadError) {
              console.warn("Could not reconcile state after import failure", reloadError);
            }
            throw saveError;
          }
          clearAllBookTextCaches();
          await applyBridgeCommandResult(result, previousView);
        });
      } else {
        clearAllBookTextCaches();
        replaceState(imported);
        ensureCurrentText();
        await saveState();
      }

      renderImportedState();
      showToast(t("toast.importDone"));
    } catch (error) {
      console.warn(error);
      showToast(t("toast.importFailed"));
    }
  });
  reader.readAsText(file);
  event.target.value = "";
}

export async function clearWords() {
  const confirmed = window.confirm(t("toast.confirmClearWords"));
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;
  const lang = state.preferences?.learningLanguage || "de";
  state.vocab = {};
  if (state.profiles?.[lang]) {
    state.profiles[lang].vocab = state.vocab;
  }
  state.selectedWord = null;
  state.reviewIndex = 0;
  resetInitialVocabKeys();
  hideReviewAnswer();
  try {
    await saveStateAndReloadBridge(state.currentView || "settings");
  } catch (error) {
    console.warn("clear words save failed", error);
    await reloadBridgeSnapshot(state.currentView || "settings").catch((reloadError) => {
      console.warn("clear words recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return;
  }
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLibrary() {
  const confirmed = window.confirm(t("toast.confirmClearLibrary"));
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;
  const lang = state.preferences?.learningLanguage || "de";
  const removedTextIds = state.customTexts.map((text) => text.id);
  const removedUserBookIds = state.userBooks.map((book) => book.id);
  if (window.__qtBridge) {
    try {
      await Promise.all(removedTextIds.map((id) => deleteStoredText(id)));
    } catch (error) {
      console.warn("clear library text delete failed", error);
      showToast(t("toast.syncUnavailable"), "error");
      return;
    }
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
  [...removedTextIds, ...removedUserBookIds].forEach(clearBookTextCache);
  try {
    await saveStateAndReloadBridge(state.currentView || "settings");
  } catch (error) {
    console.warn("clear library save failed", error);
    await reloadBridgeSnapshot(state.currentView || "settings").catch((reloadError) => {
      console.warn("clear library recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return;
  }
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLocalState() {
  const confirmed = window.confirm(t("toast.confirmClear"));
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;

  if (window.__qtBridge) {
    try {
      const result = await postStoreCommand("/__store/wipe");
      await applyBridgeCommandResult(result, state.currentView || "settings");
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn("wipe failed", error);
      showToast(t("toast.syncUnavailable"), "error");
      return;
    }
  } else {
    localStorage.removeItem(STORAGE_KEY);
    replaceState(createDefaultState());
    await saveState();
  }

  clearAllBookTextCaches();
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
    showToast(await nativeSave(result.content, result.filename, result.mime) ? t("toast.exportReady") : t("toast.exportCancelled"));
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
