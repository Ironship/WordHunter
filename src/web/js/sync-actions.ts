import { applyBridgeSnapshotToState, getDurableStateRevision, state, saveState, saveUiState, createDefaultState, replaceState, resetInitialVocabKeys, runExclusiveStateWrite, clearLastReadTextForLanguage } from "./state.js";
import { STORAGE_KEY, UI_STORAGE_KEY } from "./constants.js";
import { buildSavePayload } from "./api.js";
import { showToast } from "./toast.js";
import { showConfirmDialog } from "./dialog-backdrop.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { getVocabularyTextById, loadTextVocabularyIndex } from "./text-vocab.js";
import { VOCAB_STATUS_FILTERS } from "./events/vocab-status.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "./bridge-commit.js";
import { acknowledgeBackendSnapshot, deleteStoredText, loadBackendSnapshot, postStoreCommand } from "./store-bridge.js";
import { clearAllBookTextCaches, clearBookTextCache } from "./books.js";
import { isCustomTextReferenced } from "./book-actions/profile-library.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";

const WH_TOKEN_HEADER = { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" };
const MAX_ANKI_IMPORT_BYTES = 32 * 1024 * 1024;

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
  count: number;
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
  return { content: value.content, filename: value.filename, mime: value.mime, count: Number(value.count) || 0 };
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

function waitForAndroidExport(start: (requestId: string) => boolean): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const requestId = createAndroidExportRequestId();
    const overallDeadline = Date.now() + 15 * 60 * 1000;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-export", onResult);
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const onResult = (event: Event) => {
      const detail = eventDetail(event);
      if (detail.requestId !== requestId) return;
      if (detail.terminal === false) {
        if (timeout !== null) clearTimeout(timeout);
        const remaining = overallDeadline - Date.now();
        timeout = setTimeout(
          () => fail("android export write timed out"),
          Math.min(Math.max(remaining, 30_000), 5 * 60 * 1000)
        );
        return;
      }
      cleanup();
      if (detail.cancelled) {
        resolve(false);
      } else if (detail.success) {
        resolve(true);
      } else {
        reject(new Error(String(detail.error || detail.status || "android export failed")));
      }
    };
    timeout = setTimeout(() => fail("android export timed out"), 130000);

    window.addEventListener("wordhunter:android-export", onResult);
    try {
      if (start(requestId) === false) {
        cleanup();
        resolve(false);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function saveWithAndroidBridge(data: string, filename: string, mime: string): Promise<boolean> | null {
  const bridge = window.WordHunterAndroid;
  if (typeof bridge?.saveExport !== "function") return null;
  return waitForAndroidExport((requestId) => bridge.saveExport(data, filename, mime, requestId));
}

function saveFileWithAndroidBridge(path: string, filename: string): Promise<boolean> | null {
  const bridge = window.WordHunterAndroid;
  if (typeof bridge?.saveExportFile !== "function") return null;
  return waitForAndroidExport((requestId) => bridge.saveExportFile(path, filename, "application/zip", requestId));
}

async function nativeSave(data: string, filename: string, mime: string): Promise<boolean> {
  const androidSaved = saveWithAndroidBridge(data, filename, mime);
  if (androidSaved) return androidSaved;
  if (window.WordHunterAndroid) {
    throw new Error("Android export bridge is unavailable");
  }
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

function removeUnreferencedBookState(value: WhAppState, candidates: Iterable<string>): void {
  const referenced = new Set<string>();
  for (const text of [...(value.customTexts || []), ...(value.userBooks || [])]) referenced.add(text.id);
  for (const profile of Object.values(value.profiles || {})) {
    for (const text of [...(profile.customTexts || []), ...(profile.userBooks || [])]) referenced.add(text.id);
  }
  const removed = new Set([...candidates].filter((id) => !referenced.has(id)));
  if (!removed.size) return;
  const bookmarks = value.preferences?.readerBookmarks;
  for (const id of removed) {
    if (bookmarks) delete bookmarks[id];
    if (value.readerPages) delete value.readerPages[id];
    if (value.readerScrolls) delete value.readerScrolls[id];
  }
  for (const [lang, id] of Object.entries(value.preferences?.lastReadTextIds || {})) {
    if (removed.has(String(id))) delete value.preferences.lastReadTextIds[lang];
  }
  for (const key of Object.keys(value.readerScrollsPerPage || {})) {
    if ([...removed].some((id) => key.startsWith(id) && /^-p\d+$/.test(key.slice(id.length)))) {
      delete value.readerScrollsPerPage[key];
    }
  }
  value.archivedBookIds = (value.archivedBookIds || []).filter((id) => !removed.has(id));
  for (const profile of Object.values(value.profiles || {})) {
    profile.archivedBookIds = (profile.archivedBookIds || []).filter((id) => !removed.has(id));
  }
  if (value.currentTextId && removed.has(value.currentTextId)) {
    value.currentTextId = null;
    if (value.currentView === "reader") value.currentView = "library";
    value.readerPage = 1;
    value.selectedWord = null;
    value.selectedWordIndex = null;
    value.readerSelectionRange = null;
  }
  if (value.filters?.vocabTextId && removed.has(value.filters.vocabTextId)) {
    value.filters.vocabTextId = "all";
  }
}

async function backupBeforeClear() {
  try {
    if (!await exportTransfer("all", "wordhunter-backup-before-clear", false)) {
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

function waitForAndroidImport(): Promise<string | null> | null {
  const bridge = window.WordHunterAndroid;
  if (typeof bridge?.chooseImportPackage !== "function") return null;
  return new Promise<string | null>((resolve, reject) => {
    const requestId = `android-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("wordhunter:android-import", onResult);
    };
    const onResult = (event: Event) => {
      const detail = eventDetail(event);
      if (detail.requestId !== requestId) return;
      cleanup();
      if (detail.cancelled) resolve(null);
      else if (detail.success && typeof detail.path === "string") resolve(detail.path);
      else reject(new Error(String(detail.error || "android import failed")));
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("android import timed out"));
    }, 10 * 60 * 1000);
    window.addEventListener("wordhunter:android-import", onResult);
    try {
      if (bridge.chooseImportPackage(requestId) === false) {
        cleanup();
        resolve(null);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

// A stuck backend job must not pin the export UI forever.
const EXPORT_JOB_DEADLINE_MS = 5 * 60 * 1000;
let transferInProgress = false;
let exportProgressOverlay: HTMLDivElement | null = null;

function phaseLabel(phase: string): string {
  const key = `transfer.phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
  const value = t(key);
  return value === key ? "" : value;
}

function showExportProgress(): void {
  hideExportProgress();
  const overlay = document.createElement("div");
  overlay.id = "export-progress-overlay";
  overlay.className = "export-progress-overlay";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="ocr-progress-card">
      <div class="ocr-progress-document" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
        <i class="ocr-progress-scan-line"></i>
      </div>
      <div class="ocr-progress-copy">
        <p id="export-progress-text"></p>
        <p class="muted-copy ocr-progress-eta" id="export-progress-eta"></p>
      </div>
      <div class="ocr-progress-bar" aria-hidden="true"><div class="ocr-progress-bar-fill" id="export-progress-fill"></div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  exportProgressOverlay = overlay;
}

function updateExportProgress(percent: number, phase: string): void {
  const overlay = exportProgressOverlay;
  if (!overlay) return;
  const clamped = Math.min(100, Math.max(0, Math.trunc(percent)));
  const text = overlay.querySelector("#export-progress-text");
  const eta = overlay.querySelector("#export-progress-eta");
  const fill = overlay.querySelector<HTMLElement>("#export-progress-fill");
  if (text) text.textContent = t("transfer.exportProgress", { percent: clamped });
  if (eta) eta.textContent = phaseLabel(phase);
  if (fill) fill.style.width = `${clamped}%`;
}

function hideExportProgress(): void {
  exportProgressOverlay?.remove();
  exportProgressOverlay = null;
}

export async function waitForExportJob(job: string): Promise<boolean> {
  showExportProgress();
  const deadline = Date.now() + EXPORT_JOB_DEADLINE_MS;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(t("toast.exportTimedOut"));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const response = await fetch(`/__store/export_progress?job=${encodeURIComponent(job)}`, {
        headers: { "X-WH-Token": window.WH_TOKEN || "" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`export progress HTTP ${response.status}`);
      const progress = await response.json() as UnknownRecord;
      if (progress.done === true) {
        if (progress.error) throw new Error(String(progress.error));
        return true;
      }
      updateExportProgress(Number(progress.percent) || 0, String(progress.phase || ""));
    }
  } finally {
    hideExportProgress();
  }
}

export function transferErrorMessage(error: unknown): string {
  // Errors from other realms (webview bridge, iframes) can fail the
  // `instanceof Error` check, so fall back to a duck-typed `message` field.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error || "");
  // Known internal literals map to localized strings; anything else
  // (backend/HTTP text) is English-only and stays in the console.
  if (message.includes("transfer export response is missing a saved file")) return t("toast.transferMissingFile");
  if (message.includes("Android export bridge is unavailable")) return t("toast.androidExportUnavailable");
  const http = message.match(/(?:export|import)(?: progress)? HTTP (\d{3})/);
  if (http) return t("transfer.httpError", { status: http[1] });
  if (message.includes("android export write timed out")) return t("transfer.exportWriteTimeout");
  if (message.includes("android export timed out")) return t("transfer.exportWriteTimeout");
  if (message.includes("android export failed")) return t("transfer.exportWriteTimeout");
  if (message === t("toast.exportTimedOut")) return message;
  const trimmed = message.replace(/\s+/g, " ").trim();
  // Raw backend bodies (e.g. JSON error payloads) must never reach a toast.
  if (trimmed.startsWith("{")) return t("transfer.genericError");
  console.warn("Transfer error is not localized; keeping it out of the UI:", error);
  return "";
}

export async function exportTransfer(
  scope: "all" | "vocabulary",
  prefix = scope === "all" ? "wordhunter-full" : "wordhunter-words",
  notify = true
): Promise<boolean> {
  if (transferInProgress) {
    if (notify) showToast(t("toast.transferBusy"), "error");
    return false;
  }
  transferInProgress = true;
  const filename = `${prefix}-${new Date().toISOString().slice(0, 10)}.zip`;
  try {
    await window.flushAllPendingFrontendState?.();
    const requestId = `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch("/__store/export_transfer", {
      method: "POST",
      headers: WH_TOKEN_HEADER,
      body: JSON.stringify({ scope, filename, requestId })
    });
    if (!response.ok) throw new Error((await response.text()).trim() || `export HTTP ${response.status}`);
    const result = await response.json() as UnknownRecord;
    if (typeof result.job === "string") {
      const ok = await waitForExportJob(result.job);
      if (!ok) return false;
    } else if (result.saved === false) {
      if (notify) showToast(t("toast.exportCancelled"));
      return false;
    } else if (typeof result.path === "string") {
      const saved = await saveFileWithAndroidBridge(result.path, filename);
      if (!saved) {
        if (notify) showToast(t("toast.exportCancelled"));
        return false;
      }
    } else if (result.saved !== true) {
      throw new Error("transfer export response is missing a saved file");
    }
    if (notify) showToast(t("toast.transferExported"));
    return true;
  } catch (error) {
    console.warn("transfer export failed", error);
    const detail = transferErrorMessage(error);
    if (notify) showToast(detail ? `${t("toast.exportFailed")}: ${detail}` : t("toast.exportFailed"), "error");
    return false;
  } finally {
    transferInProgress = false;
  }
}

export async function importTransfer(): Promise<boolean> {
  if (transferInProgress) {
    showToast(t("toast.transferBusy"), "error");
    return false;
  }
  transferInProgress = true;
  try {
    await window.flushAllPendingFrontendState?.();
    const androidImport = waitForAndroidImport();
    const androidPath = androidImport ? await androidImport : undefined;
    if (androidImport && androidPath === null) {
      showToast(t("toast.importCancelled"));
      return false;
    }
    const response = await fetch("/__store/import_transfer", {
      method: "POST",
      headers: WH_TOKEN_HEADER,
      body: JSON.stringify(androidPath ? { path: androidPath } : {})
    });
    if (!response.ok) throw new Error((await response.text()).trim() || `import HTTP ${response.status}`);
    const result = await response.json() as UnknownRecord;
    if (result.imported === false) return false;
    clearAllBookTextCaches();
    const reloaded = await reloadBridgeSnapshot();
    ensureCurrentText();
    render();
    if (reloaded) {
      showToast(t("toast.transferImported"));
    } else {
      showToast(t("toast.transferImportedReload"), "error");
    }
    return true;
  } catch (error) {
    console.warn("transfer import failed", error);
    const detail = transferErrorMessage(error);
    showToast(detail ? `${t("toast.importFailed")}: ${detail}` : t("toast.importFailed"), "error");
    return false;
  } finally {
    transferInProgress = false;
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

async function applyBridgeCommandResult(result: unknown, expectedRevision?: number, preserveLocalUi = true): Promise<boolean> {
  if (!window.__qtBridge) return true;
  const snapshot = (isRecord(result) ? result.snapshot : undefined) || await loadBackendSnapshot();
  if (!snapshot || !applyBridgeSnapshotToState(snapshot, { expectedRevision, preserveLocalUi })) return false;
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
    lang: effectiveLearningLanguage(state.preferences),
    algorithm: state.preferences?.wordDetectionAlgorithm || "modern"
  };
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
    showToast(t("toast.vocabExportFailed"), "error");
  }
}

export async function clearWords(): Promise<void> {
  const confirmed = await showConfirmDialog({ title: t("dialog.confirmTitle"), message: t("toast.confirmClearWords"), danger: true });
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
    showToast(t("toast.saveUnavailable"), "error");
    return;
  }
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLibrary(): Promise<void> {
  const confirmed = await showConfirmDialog({ title: t("dialog.confirmTitle"), message: t("toast.confirmClearLibrary"), danger: true });
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;
  const lang = state.preferences?.learningLanguage || "de";
  const removedTextIds = state.customTexts.map((text) => text.id);
  const removedUserBookIds = state.userBooks.map((book) => book.id);
  state.customTexts = [];
  state.userBooks = [];
  state.hiddenBuiltInBooks = [];
  state.archivedBookIds = [];
  state.currentTextId = null;
  state.selectedWord = null;
  state.selectedWordIndex = null;
  state.readerSelectionRange = null;
  clearLastReadTextForLanguage(lang);
  state.readerPage = 1;
  if (state.profiles?.[lang]) {
    state.profiles[lang].customTexts = state.customTexts;
    state.profiles[lang].userBooks = state.userBooks;
    state.profiles[lang].hiddenBuiltInBooks = state.hiddenBuiltInBooks;
    state.profiles[lang].archivedBookIds = state.archivedBookIds;
  }
  removeUnreferencedBookState(state, [...removedTextIds, ...removedUserBookIds]);
  [...removedTextIds, ...removedUserBookIds].forEach(clearBookTextCache);
  try {
    await saveStateAndReloadBridge();
  } catch (error) {
    console.warn("clear library save failed", error);
    await reloadBridgeSnapshot().catch((reloadError) => {
      console.warn("clear library recovery reload failed", reloadError);
    });
    showToast(t("toast.saveUnavailable"), "error");
    return;
  }
  if (window.__qtBridge) {
    const unreferencedTextIds = removedTextIds.filter((id) => !isCustomTextReferenced(id));
    const cleanup = await Promise.allSettled(unreferencedTextIds.map((id) => deleteStoredText(id)));
    cleanup.forEach((result) => {
      if (result.status === "rejected") console.warn("clear library media cleanup failed", result.reason);
    });
  }
  ensureCurrentText();
  render();
  showToast(t("toast.dataCleared"));
}

export async function clearLocalState(): Promise<void> {
  const confirmed = await showConfirmDialog({ title: t("dialog.confirmTitle"), message: t("toast.confirmClear"), danger: true });
  if (!confirmed) return;
  if (!await backupBeforeClear()) return;

  if (window.__qtBridge) {
    try {
      await runExclusiveStateWrite(async () => {
        const result = await postStoreCommand("/__store/wipe");
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(UI_STORAGE_KEY);
        try {
          if (!await applyBridgeCommandResult(result, undefined, false)) {
            replaceState(createDefaultState(), { save: false });
          }
        } catch (error) {
          console.warn("wiped backend snapshot could not be applied; using an empty local state", error);
          replaceState(createDefaultState(), { save: false });
        }
      });
    } catch (error) {
      console.warn("wipe failed", error);
      showToast(t("toast.saveUnavailable"), "error");
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
    lang: effectiveLearningLanguage(state.preferences),
    algorithm: state.preferences?.wordDetectionAlgorithm || "modern"
  };
  try {
    const result = vocabularyExportFile(await requestVocabExport(payload));
    if (!result) {
      showToast(t("toast.ankiExportEmpty"));
      return;
    }
    if (await nativeSave(result.content, result.filename, result.mime)) {
      showToast(t("toast.exportReadyCount", { n: result.count || 0 }));
    } else {
      showToast(t("toast.exportCancelled"));
    }
  } catch (error) {
    console.warn("anki export failed", error);
    showToast(t("toast.vocabExportFailed"), "error");
  }
}

export function importAnkiTsv(event: unknown): void {
  const target = fileInputTarget(event);
  const file = target?.files?.[0];
  if (!file) return;
  if (Number(file.size) > MAX_ANKI_IMPORT_BYTES) {
    showToast(t("toast.backupTooLarge", { mb: MAX_ANKI_IMPORT_BYTES / (1024 * 1024) }));
    target.value = "";
    return;
  }
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
      await saveStateAndReloadBridge();
      render();
      showToast(t("toast.importDoneCount", { count: importedCount }));
    } catch (error) {
      console.warn(error);
      if (window.__qtBridge) {
        await reloadBridgeSnapshot().catch((reloadError) => {
          console.warn("Anki import recovery reload failed", reloadError);
        });
      }
      showToast(t("toast.importFailed"));
    }
  });
  const readFailed = () => showToast(t("toast.importFailed"));
  reader.addEventListener("error", readFailed);
  reader.addEventListener("abort", readFailed);
  reader.readAsText(file);
  target.value = "";
}

function parseAnkiTsvLocally(text: string): AnkiImportRow[] {
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
