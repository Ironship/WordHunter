import { setEntryStatus } from "./vocabulary/entry-state.js";

export interface WordHunterWowRow {
  word: string;
  status: WhVocabStatus;
  statusChangedAt: number;
  updatedAt: number;
  translation: string;
  context: string;
  questId: string;
  questTitle: string;
}

const PREFIX = "WHW1|";
const SAFE_PAYLOAD = /^[A-Za-z0-9_.~%|,;:-]*$/;
const STATUSES = new Set<WhVocabStatus>(["new", "learning", "known", "ignored"]);

function decodeField(value: string): string {
  return decodeURIComponent(value).normalize("NFC");
}

function timestamp(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000_000_000) {
    throw new Error("WordHunterWoW export contains an invalid timestamp");
  }
  return parsed;
}

export function parseWordHunterWowSavedVariables(source: string): WordHunterWowRow[] {
  const match = source.match(/(?:^|\r?\n)\s*WordHunterWoWExport\s*=\s*"([^"]*)"/);
  if (!match) throw new Error("WordHunterWoWExport was not found");
  const payload = match[1];
  if (!payload.startsWith(PREFIX) || !SAFE_PAYLOAD.test(payload)) {
    throw new Error("WordHunterWoW export has an unsupported format");
  }

  const rows: WordHunterWowRow[] = [];
  const records = payload.slice(PREFIX.length);
  if (!records) return rows;
  for (const record of records.split(";")) {
    const fields = record.split(",");
    if (fields.length !== 8) throw new Error("WordHunterWoW export contains an invalid record");
    const status = fields[1] as WhVocabStatus;
    if (!STATUSES.has(status)) throw new Error("WordHunterWoW export contains an invalid status");
    const word = decodeField(fields[0]).trim();
    if (!word) continue;
    rows.push({
      word,
      status,
      statusChangedAt: timestamp(fields[2]),
      updatedAt: timestamp(fields[3]),
      translation: decodeField(fields[4]).trim(),
      context: decodeField(fields[5]).trim(),
      questId: decodeField(fields[6]).trim(),
      questTitle: decodeField(fields[7]).trim()
    });
  }
  return rows;
}

function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function isoTime(value: string | undefined): number {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeWordHunterWowEntry(
  entry: WhVocabEntry,
  row: WordHunterWowRow,
  existedBeforeImport: boolean
): boolean {
  const before = JSON.stringify(entry);
  const importedStatusTime = row.statusChangedAt * 1000;
  const localStatusTime = existedBeforeImport ? isoTime(entry.statusUpdatedAt || entry.updatedAt) : 0;
  const localUpdatedTime = existedBeforeImport ? isoTime(entry.updatedAt) : 0;
  const localUpdatedAt = entry.updatedAt;
  if (importedStatusTime >= localStatusTime) {
    const statusIso = unixSecondsToIso(row.statusChangedAt);
    if (entry.status === row.status) {
      entry.statusUpdatedAt = statusIso;
      if (importedStatusTime > localUpdatedTime) entry.updatedAt = statusIso;
    } else {
      setEntryStatus(entry, row.status, statusIso);
      if (localUpdatedTime > importedStatusTime) entry.updatedAt = localUpdatedAt;
    }
  }
  if (row.translation && (row.updatedAt * 1000 >= localUpdatedTime || !entry.translation)) {
    entry.translation = row.translation;
    entry.updatedAt = unixSecondsToIso(row.updatedAt);
  }
  return JSON.stringify(entry) !== before;
}
