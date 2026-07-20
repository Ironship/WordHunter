import { applyBridgeSnapshotToState, getDurableStateRevision, state, saveState, saveUiState, createDefaultState, normalizeState, replaceState, resetInitialVocabKeys, runExclusiveStateWrite, clearLastReadTextForLanguage } from "./state.js";
import { STATE_SCHEMA_VERSION, STORAGE_KEY, UI_STORAGE_KEY } from "./constants.js";
import { buildSavePayload } from "./api.js";
import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { render, ensureCurrentText } from "./render.js";
import { getOrCreateEntry, hideReviewAnswer } from "./views/vocabulary.js";
import { getVocabularyTextById, loadTextVocabularyIndex } from "./text-vocab.js";
import { VOCAB_STATUS_FILTERS } from "./events/vocab-status.js";
import { reloadBridgeSnapshot, saveStateAndReloadBridge } from "./bridge-commit.js";
import { acknowledgeBackendSnapshot, deleteStoredText, loadBackendSnapshot, postStoreCommand, postStoreJson } from "./store-bridge.js";
import { assertSupportedStateSchemaVersion } from "./state/normalize.js";
import { captureUiState } from "./state/ui-cache.js";
import { clearAllBookTextCaches, clearBookTextCache, loadAllBookTexts, loadAllCustomTextContents, loadCustomTextContent } from "./books.js";
import { isCustomTextReferenced } from "./book-actions/profile-library.js";

const WH_TOKEN_HEADER = { "Content-Type": "application/json", "X-WH-Token": window.WH_TOKEN || "" };
const LAST_BACKUP_KEY = `${STORAGE_KEY}:last-backup`;
const MAX_STATE_IMPORT_BYTES = 128 * 1024 * 1024;
const MAX_ANKI_IMPORT_BYTES = 32 * 1024 * 1024;
const MAX_POCKET_EXPORT_BYTES = 32 * 1024 * 1024;
const PORTABLE_BACKUP_TEXT_CONCURRENCY = 2;

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

export function exceedsPocketExportLimit(
  data: string,
  maxBytes = MAX_POCKET_EXPORT_BYTES
): boolean {
  if (data.length > maxBytes) return true;
  let bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < data.length
      && data.charCodeAt(index + 1) >= 0xdc00 && data.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}

export function saveWithAndroidBridge(data: string, filename: string, mime: string): Promise<boolean> | null {
  const bridge = window.WordHunterAndroid;
  if (typeof bridge?.saveExport !== "function") return null;
  if (exceedsPocketExportLimit(data)) {
    return Promise.reject(new Error("Pocket export exceeds the 32 MB safety limit."));
  }
  return new Promise<boolean>((resolve, reject) => {
    const requestId = createAndroidExportRequestId();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      window.removeEventListener("wordhunter:android-export", onResult);
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
    };
    const onResult = (event: Event) => {
      const detail = eventDetail(event);
      if (detail.requestId !== requestId) return;
      if (detail.terminal === false) {
        if (detail.status === "writing" && timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
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
    timeout = setTimeout(() => {
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

function customTextRecords(value: unknown): WhText[] {
  if (!isRecord(value)) return [];
  const records = Array.isArray(value.customTexts) ? value.customTexts.filter(isRecord) as WhText[] : [];
  if (!isRecord(value.profiles)) return records;
  for (const profile of Object.values(value.profiles)) {
    if (isRecord(profile) && Array.isArray(profile.customTexts)) {
      records.push(...profile.customTexts.filter(isRecord) as WhText[]);
    }
  }
  return records;
}

function setTextBody(value: unknown, id: string, text: string): void {
  for (const record of customTextRecords(value)) {
    if (record.id === id) record.text = text;
  }
}

function propagateEmbeddedTextBodies(value: unknown): void {
  const bodies = new Map<string, string>();
  for (const record of customTextRecords(value)) {
    if (typeof record.id === "string" && typeof record.text === "string" && record.text.trim()) {
      bodies.set(record.id, record.text);
    }
  }
  for (const [id, text] of bodies) setTextBody(value, id, text);
}

function setPortableTextBody(value: WhRecord, id: string, text: string): void {
  let storedInProfile = false;
  if (isRecord(value.profiles)) {
    for (const profile of Object.values(value.profiles)) {
      if (!isRecord(profile) || !Array.isArray(profile.customTexts)) continue;
      for (const record of profile.customTexts.filter(isRecord) as WhText[]) {
        if (record.id !== id) continue;
        record.text = text;
        storedInProfile = true;
      }
    }
  }
  if (storedInProfile || !Array.isArray(value.customTexts)) return;
  for (const record of value.customTexts.filter(isRecord) as WhText[]) {
    if (record.id === id) record.text = text;
  }
}

interface PortableBackupResult {
  payload: string;
  textCount: number;
  missingTextCount: number;
}

async function portableBackupPayload(): Promise<PortableBackupResult> {
  const portable = JSON.parse(JSON.stringify(state)) as WhRecord;
  const sources = new Map<string, WhText>();
  for (const text of customTextRecords(state)) {
    if (typeof text.id === "string" && text.id) sources.set(text.id, text);
  }
  const missingTextIds: string[] = [];
  const entries = [...sources];
  let nextIndex = 0;
  const loadNextText = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      const [id, metadata] = entries[nextIndex++];
      try {
        const text = await loadCustomTextContent(metadata);
        if (!text.trim()) throw new Error("stored text is empty");
        setPortableTextBody(portable, id, text);
      } catch (error) {
        console.warn(`Could not include book text in backup: ${id}`, error);
        missingTextIds.push(id);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(PORTABLE_BACKUP_TEXT_CONCURRENCY, entries.length) },
    () => loadNextText()
  ));
  portable.backupIncludesTextBodies = missingTextIds.length === 0;
  portable.backupMissingTextIds = missingTextIds.sort();
  portable.backupIncludesMediaFiles = false;
  const payload = JSON.stringify(portable, null, 2);
  const payloadBytes = new Blob([payload], { type: "application/json" }).size;
  if (Number.isFinite(payloadBytes) && payloadBytes > MAX_STATE_IMPORT_BYTES) {
    throw new Error(`Portable backup exceeds ${MAX_STATE_IMPORT_BYTES} bytes`);
  }
  return { payload, textCount: sources.size, missingTextCount: missingTextIds.length };
}

function removeImportedTexts(value: WhAppState, ids: Set<string>): void {
  value.customTexts = (value.customTexts || []).filter((text) => !ids.has(text.id));
  for (const profile of Object.values(value.profiles || {})) {
    profile.customTexts = (profile.customTexts || []).filter((text) => !ids.has(text.id));
  }
  const activeLanguage = value.preferences?.learningLanguage || "de";
  if (value.profiles?.[activeLanguage]) value.customTexts = value.profiles[activeLanguage].customTexts;
  removeUnreferencedBookState(value, ids);
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

function degradeMissingPdfMediaToText(value: WhAppState): void {
  for (const text of customTextRecords(value)) {
    if (text.pdfOcrPages?.length && typeof text.text === "string" && text.text.trim()) {
      delete text.pdfOcrPages;
    }
    if (typeof text.coverDataUrl === "string" && text.coverDataUrl.startsWith("/__media")) {
      text.coverDataUrl = "";
    }
    if (typeof text.text === "string" && text.text.includes("[IMG:")) {
      text.text = text.text.replace(/\s*\[IMG:[^\]]+\]\s*/g, "\n").trim();
    }
  }
}

async function recoverImportedTextBodies(value: WhAppState): Promise<number> {
  const records = new Map<string, WhText>();
  for (const text of customTextRecords(value)) {
    if (typeof text.id === "string" && text.id) records.set(text.id, text);
  }
  const missing = new Set<string>();
  for (const [id, metadata] of records) {
    if (typeof metadata.text === "string" && metadata.text.trim()) continue;
    if (!window.__qtBridge) {
      missing.add(id);
      continue;
    }
    try {
      const response = await fetch(`/__book/text?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`existing text load HTTP ${response.status}: ${id}`);
      const result: unknown = await response.json();
      const text = isRecord(result) && typeof result.text === "string" ? result.text : "";
      if (text.trim()) setTextBody(value, id, text);
      else missing.add(id);
    } catch (error) {
      console.warn(`Could not recover imported text body ${id}`, error);
      missing.add(id);
    }
  }
  if (missing.size) removeImportedTexts(value, missing);
  return missing.size;
}

async function backupBeforeClear() {
  const filename = `wordhunter-backup-before-clear-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const backup = await portableBackupPayload();
    try {
      localStorage.setItem(LAST_BACKUP_KEY, backup.payload);
    } catch (error) {
      console.warn("local backup cache is unavailable", error);
    }
    if (!await nativeSave(backup.payload, filename, "application/json") || backup.missingTextCount > 0) {
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
  const filename = `wordhunter-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const backup = await portableBackupPayload();
    if (!await nativeSave(backup.payload, filename, "application/json")) {
      showToast(t("toast.exportCancelled"));
    } else if (backup.missingTextCount > 0) {
      showToast(t("toast.exportReadyMissingTexts", { n: backup.missingTextCount }));
    } else {
      showToast(backup.textCount > 0 ? t("toast.exportReadyWithoutMedia") : t("toast.exportReady"));
    }
  } catch (error) {
    console.warn("state export failed", error);
    showToast(t("toast.exportFailed"));
  }
}

export function importStateFile(event: unknown): void {
  const target = fileInputTarget(event);
  const file = target?.files?.[0];
  if (!file) return;

  if (file.size > MAX_STATE_IMPORT_BYTES) {
    showToast(t("toast.backupTooLarge", { mb: MAX_STATE_IMPORT_BYTES / (1024 * 1024) }));
    target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", async () => {
    try {
      const raw = String(reader.result || "{}");
      const parsed: unknown = JSON.parse(raw);
      assertSupportedStateSchemaVersion(parsed, "import file");
      // JSON backups do not carry binary book assets; legacy marker values are not proof that
      // the corresponding /__media files exist on this device.
      const backupOmitsMedia = customTextRecords(parsed).length > 0;
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

      propagateEmbeddedTextBodies(parsed);
      const imported = normalizeState({ ...createDefaultState(), ...parsed });
      const missingTextCount = await recoverImportedTextBodies(imported);
      if (backupOmitsMedia) degradeMissingPdfMediaToText(imported);
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
              if (snapshot && applyBridgeSnapshotToState(snapshot, {
                expectedRevision: startingRevision,
                preserveLocalUi: false
              })) {
                await acknowledgeBackendSnapshot(snapshot);
              }
              renderImportedState();
            } catch (reloadError) {
              console.warn("Could not reconcile state after import failure", reloadError);
            }
            throw saveError;
          }
          const importedUiState = { schemaVersion: STATE_SCHEMA_VERSION, ...captureUiState(imported) };
          if (isRecord(result) && isRecord(result.snapshot)) result.snapshot.uiState = importedUiState;
          try {
            await postStoreJson("/__store/ui_state", importedUiState);
          } catch (uiSaveError) {
            console.warn("Imported data was saved, but its Reader position needs a retry", uiSaveError);
            void saveUiState();
          }
          clearAllBookTextCaches();
          if (!await applyBridgeCommandResult(result, startingRevision, false)) {
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
      showToast(missingTextCount
        ? t(backupOmitsMedia ? "toast.importDoneMissingTextsWithoutMedia" : "toast.importDoneMissingTexts", { n: missingTextCount })
        : t(backupOmitsMedia ? "toast.importDoneWithoutMedia" : "toast.importDone"));
    } catch (error) {
      console.warn(error);
      showToast(t("toast.importFailed"));
    }
  });
  const readFailed = () => showToast(t("toast.importFailed"));
  reader.addEventListener("error", readFailed);
  reader.addEventListener("abort", readFailed);
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
    showToast(t("toast.syncUnavailable"), "error");
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
  const confirmed = window.confirm(t("toast.confirmClear"));
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
