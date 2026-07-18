import { applyBridgeSnapshotToState, getDurableStateRevision, state, saveState, createDefaultState, normalizeState, replaceState, resetInitialVocabKeys, runExclusiveStateWrite, clearLastReadTextForLanguage } from "./state.js";
import { STORAGE_KEY, UI_STORAGE_KEY } from "./constants.js";
import { buildSavePayload } from "./api.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { getVocabularyTextById, loadTextVocabularyIndex } from "./text-vocab.js";
import { VOCAB_STATUS_FILTERS } from "./events/vocab-status.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "./bridge-commit.js";
import { acknowledgeBackendSnapshot, deleteStoredText, loadBackendSnapshot, postStoreCommand } from "./store-bridge.js";
import { assertSupportedStateSchemaVersion } from "./state/normalize.js";
import { clearAllBookTextCaches, clearBookTextCache, loadAllBookTexts, loadAllCustomTextContents } from "./books.js";

const WH_TOKEN_HEADER = { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" };
const LAST_BACKUP_KEY = `${STORAGE_KEY}:last-backup`;

type UnknownRecord = Record<string, unknown>;
type VocabularyExportFormat = "txt" | "anki";

interface VocabularyExportTextIndex {
  words: string[];
  tokenLine: string;
}

interface VocabularyExportRequest {
  op: "export";
  vocab: WhVocabulary;
  query: string;
  statuses: WhVocabStatus[];
  textIndex: VocabularyExportTextIndex | null;
  format: VocabularyExportFormat;
  filename: string;
  headerRow: string | undefined;
  lang: string;
  algorithm: string;
}

interface VocabularyExportFile {
  content: string;
  filename: string;
  mime: string;
}

interface AnkiImportRow {
  word: string;
  translation: string;
  context: string;
  article: string;
}

const LOCALIZED_ANKI_WORD_HEADERS = new Set([
  "word",
  "słowo",
  "wort",
  "palabra",
  "mot",
  "parola",
  "単語",
  "слово"
]);
const LOCALIZED_ANKI_TRANSLATION_HEADERS = new Set([
  "translation",
  "tłumaczenie",
  "übersetzung",
  "traducción",
  "traduction",
  "traduzione",
  "翻訳",
  "перевод",
  "переклад"
]);
const LOCALIZED_ANKI_CONTEXT_HEADERS = new Set([
  "context",
  "kontekst",
  "kontext",
  "contexto",
  "contexte",
  "contesto",
  "文脈",
  "контекст"
]);

function isLocalizedAnkiHeader(parts: readonly string[]): boolean {
  return parts.length >= 3
    && LOCALIZED_ANKI_WORD_HEADERS.has(parts[0]?.trim().toLowerCase() || "")
    && LOCALIZED_ANKI_TRANSLATION_HEADERS.has(parts[1]?.trim().toLowerCase() || "")
    && LOCALIZED_ANKI_CONTEXT_HEADERS.has(parts[2]?.trim().toLowerCase() || "");
}

interface FileInputTarget {
  files?: ArrayLike<File>;
  value: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventDetail(event: unknown): UnknownRecord {
  return isRecord(event) && isRecord(event.detail) ? event.detail : {};
}

function fileInputTarget(event: unknown): FileInputTarget | null {
  if (!isRecord(event) || !isRecord(event.target) || typeof event.target.value !== "string") return null;
  return event.target as unknown as FileInputTarget;
}

function vocabularyExportFile(value: unknown): VocabularyExportFile | null {
  if (!isRecord(value)) throw new Error("vocab export response is invalid");
  if (!value.count) return null;
  if (typeof value.content !== "string" || typeof value.filename !== "string" || typeof value.mime !== "string") {
    throw new Error("vocab export response is missing file data");
  }
  return { content: value.content, filename: value.filename, mime: value.mime };
}

function normalizeAnkiRows(value: unknown): AnkiImportRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AnkiImportRow[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item.word !== "string" || !item.word) continue;
    rows.push({
      word: item.word,
      translation: typeof item.translation === "string" ? item.translation : "",
      context: typeof item.context === "string" ? item.context : "",
      article: typeof item.article === "string" ? item.article : ""
    });
  }
  return rows;
}

function createAndroidExportRequestId(): string {
  return `android-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function saveWithAndroidBridge(data: string, filename: string, mime: string): Promise<boolean> | null {
  const bridge = window.WordHunterAndroid;
  if (typeof bridge?.saveExport !== "function") return null;
  return new Promise<boolean>((resolve, reject) => {
    const requestId = createAndroidExportRequestId();
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-export", onResult);
      clearTimeout(timeout);
    };
    const onResult = (event: Event) => {
      const detail = eventDetail(event);
      if (detail.requestId !== requestId) return;
      if (detail.terminal === false) return;
      cleanup();
      if (detail.cancelled) {
        resolve(false);
      } else if (detail.success) {
        resolve(true);
      } else {
        reject(new Error(String(detail.error || detail.status || "android export failed")));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("android export timed out"));
    }, 130000);

    window.addEventListener("wordhunter:android-export", onResult);
    try {
      const started = bridge.saveExport(data, filename, mime, requestId);
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

async function nativeSave(data: string, filename: string, mime: string): Promise<boolean> {
  const androidSaved = saveWithAndroidBridge(data, filename, mime);
  if (androidSaved) return androidSaved;
  if (window.__qtBridge) {
    const response = await fetch("/__export/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
      body: JSON.stringify({ data, filename, mime })
    });
    if (!response.ok) throw new Error(`export HTTP ${response.status}`);
    const result: unknown = await response.json().catch(() => ({ saved: true }));
    return !isRecord(result) || result.saved !== false;
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

export async function requestVocabExport(payload: unknown): Promise<unknown> {
  const response = await fetch("/__vocab", {
    method: "POST",
    headers: WH_TOKEN_HEADER,
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`vocab_export HTTP ${response.status}`);
  return response.json();
}

async function requestAnkiImport(tsv: string): Promise<unknown> {
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

async function applyBridgeCommandResult(result: unknown, expectedRevision?: number): Promise<boolean> {
  if (!window.__qtBridge) return true;
  const snapshot = (isRecord(result) ? result.snapshot : undefined) || await loadBackendSnapshot();
  if (!snapshot || !applyBridgeSnapshotToState(snapshot, { expectedRevision })) return false;
  await acknowledgeBackendSnapshot(snapshot);
  return true;
}

function safeFilenamePart(value: unknown): string {
  return String(value || "text")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "text";
}

function getSelectedVocabStatusesForExport(): WhVocabStatus[] {
  if (Array.isArray(state.filters?.vocabStatuses)) {
    return state.filters.vocabStatuses.filter((status) => VOCAB_STATUS_FILTERS.includes(status));
  }
  return [...VOCAB_STATUS_FILTERS];
}

async function loadTextIndexForExport(textId: string): Promise<VocabularyExportTextIndex | null> {
  if (textId === "all") return null;
  const index = await loadTextVocabularyIndex(textId);
  if (!index) throw new Error(`text vocabulary index unavailable: ${textId}`);
  return {
    words: Array.from(index.words),
    tokenLine: index.tokenLine
  };
}

function exportRequestBase(filename: string, format: VocabularyExportFormat): VocabularyExportRequest {
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

function hydrateImportedLibrary(): void {
  Promise.all([loadAllBookTexts(), loadAllCustomTextContents()])
    .then(() => render())
    .catch((error) => console.warn("Imported book hydration failed", error));
}

function renderImportedState(): void {
  ensureCurrentText();
  render();
  hydrateImportedLibrary();
}

export async function exportVocabularySelection(format: VocabularyExportFormat): Promise<void> {
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
    const result = vocabularyExportFile(await requestVocabExport(payload));
    if (!result) {
      showToast(t("toast.vocabExportEmpty"));
      return;
    }
    showToast(await nativeSave(result.content, result.filename, result.mime) ? t("toast.exportReady") : t("toast.exportCancelled"));
  } catch (error) {
    console.warn("vocab_export failed", error);
    showToast(t("toast.importFailed"));
  }
}

export async function exportState(): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  const filename = `wordhunter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  showToast(await nativeSave(payload, filename, "application/json") ? t("toast.exportReady") : t("toast.exportCancelled"));
}

export function importStateFile(event: unknown): void {
  const target = fileInputTarget(event);
  const file = target?.files?.[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    showToast(t("toast.fileError"));
    target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", async () => {
    try {
      const raw = String(reader.result || "{}");
      const parsed: unknown = JSON.parse(raw);
      assertSupportedStateSchemaVersion(parsed, "import file");
      const preview = {
        words: Object.keys(parsed.vocab || {}).length,
        texts: Array.isArray(parsed.customTexts) ? parsed.customTexts.length : 0,
        profiles: Object.keys(isRecord(parsed.profiles) ? parsed.profiles : {}).length
      };
      const msg = t("sync.importConfirm", { words: preview.words, texts: preview.texts, profiles: preview.profiles });
      if (!window.confirm(msg)) {
        target.value = "";
        return;
      }

      const imported = normalizeState({ ...createDefaultState(), ...parsed });
      if (window.__qtBridge) {
        await runExclusiveStateWrite(async () => {
          const startingRevision = getDurableStateRevision();
          let result: unknown;
          try {
            const response = await fetch("/__store/save?snapshot=1", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" },
              body: JSON.stringify(buildSavePayload(imported))
            });
            if (!response.ok) throw new Error(`import save HTTP ${response.status}`);
            result = await response.json() as unknown;
            if (!isRecord(result) || !result.snapshot) throw new Error("import save response is missing snapshot");
          } catch (saveError) {
            try {
              const snapshot = await loadBackendSnapshot();
              clearAllBookTextCaches();
              if (snapshot && applyBridgeSnapshotToState(snapshot, { expectedRevision: startingRevision })) {
                await acknowledgeBackendSnapshot(snapshot);
              }
              renderImportedState();
            } catch (reloadError) {
              console.warn("Could not reconcile state after import failure", reloadError);
            }
            throw saveError;
          }
          clearAllBookTextCaches();
          if (!await applyBridgeCommandResult(result, startingRevision)) {
            throw new Error("import snapshot was superseded by a local state change");
          }
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
  target.value = "";
}

export async function clearWords(): Promise<void> {
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
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("clear words save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("clear words recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return;
  }
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLibrary(): Promise<void> {
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
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("clear library save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("clear library recovery reload failed", reloadError);
    });
    showToast(t("toast.syncUnavailable"), "error");
    return;
  }
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLocalState(): Promise<void> {
  const confirmed = window.confirm(t("toast.confirmClear"));
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;

  if (window.__qtBridge) {
    try {
      const result = await postStoreCommand("/__store/wipe");
      await applyBridgeCommandResult(result);
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(UI_STORAGE_KEY);
    } catch (error) {
      console.warn("wipe failed", error);
      showToast(t("toast.syncUnavailable"), "error");
      return;
    }
  } else {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(UI_STORAGE_KEY);
    replaceState(createDefaultState());
    await saveState();
  }

  clearAllBookTextCaches();
  hideReviewAnswer();
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export async function exportAnkiTsv(): Promise<void> {
  const selectedStatuses: WhVocabStatus[] = Array.isArray(state.preferences?.ankiExportStatuses) && state.preferences.ankiExportStatuses.length
    ? state.preferences.ankiExportStatuses
    : ["learning"];
  const datePart = new Date().toISOString().slice(0, 10);
  const filename = `vocab-anki-${datePart}.tsv`;
  const payload: VocabularyExportRequest = {
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
    const result = vocabularyExportFile(await requestVocabExport(payload));
    if (!result) {
      showToast(t("toast.ankiExportEmpty"));
      return;
    }
    showToast(await nativeSave(result.content, result.filename, result.mime) ? t("toast.exportReady") : t("toast.exportCancelled"));
  } catch (error) {
    console.warn("anki export failed", error);
  }
}

export function importAnkiTsv(event: unknown): void {
  const target = fileInputTarget(event);
  const file = target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", async () => {
    try {
      const text = String(reader.result || "");
      let rows: AnkiImportRow[];
      if (window.__qtBridge) {
        const result = await requestAnkiImport(text);
        rows = normalizeAnkiRows(isRecord(result) ? result.rows : undefined);
      } else {
        rows = parseAnkiTsvLocally(text);
      }
      let importedCount = 0;
      for (const row of rows) {
        const word = row.word;
        if (!word) continue;
        const entry = getOrCreateEntry(word, row.context);
        if (row.translation) entry.translation = row.translation;
        if (row.article) entry.article = row.article;
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
  target.value = "";
}

export function parseAnkiTsvLocally(text: string): AnkiImportRow[] {
  const rows: AnkiImportRow[] = [];
  let isFirstNonEmptyLine = true;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    const parts = trimmed.split("\t");
    const first = parts[0]?.trim() || "";
    if (isFirstNonEmptyLine && isLocalizedAnkiHeader(parts)) {
      isFirstNonEmptyLine = false;
      continue;
    }
    isFirstNonEmptyLine = false;
    const word = first;
    if (!word) continue;
    rows.push({
      word,
      translation: parts[1]?.trim() || "",
      context: parts[2]?.trim() || "",
      article: parts[3]?.trim() || ""
    });
  }
  return rows;
}
