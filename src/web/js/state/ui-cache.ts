import { STATE_SCHEMA_VERSION, UI_STORAGE_KEY } from "../constants.js";

export const UI_STATE_KEYS = [
  "currentView",
  "currentTextId",
  "selectedWord",
  "selectedWordIndex",
  "readerSelectionRange",
  "reviewIndex",
  "readerFontSize",
  "readerPdfZoom",
  "readerPdfViewMode",
  "readerPage",
  "readerPages",
  "readerScrolls",
  "readerScrollsPerPage",
  "filters"
] as const;

export function captureUiState(rawState: WhRecord): WhRecord {
  const captured: WhRecord = {};
  for (const key of UI_STATE_KEYS) {
    if (rawState[key] !== undefined) captured[key] = rawState[key];
  }
  return captured;
}

export function saveUiStateCache(serializedUiState: string | WhRecord): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(UI_STORAGE_KEY, typeof serializedUiState === "string"
      ? serializedUiState
      : JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, ...captureUiState(serializedUiState) }));
  } catch (error) {
    console.warn("Failed to save local UI state", error);
  }
}

export function loadUiStateCache(): WhRecord {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as WhRecord;
    if (record.schemaVersion !== STATE_SCHEMA_VERSION) return {};
    return captureUiState(record);
  } catch (error) {
    console.warn("Failed to read local UI state", error);
    return {};
  }
}
