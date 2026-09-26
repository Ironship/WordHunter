type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return String(value || "");
}

function normalizeSubtitleText(value: unknown): string {
  return stringValue(value)
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinSubtitleLines(lines: readonly string[]): string {
  return lines
    .map(normalizeSubtitleText)
    .filter(Boolean)
    .filter((line, index, all) => line !== all[index - 1])
    .join("\n");
}

function stripBom(text: unknown): string {
  return stringValue(text).replace(/^\uFEFF/, "");
}

// The usual pre-Unicode Windows code page for text in a language, used when a
// file is not valid UTF-8 (the "Other" profile can hold any language).
const LEGACY_ENCODINGS: Record<string, string> = {
  pl: "windows-1250", cs: "windows-1250", sk: "windows-1250", hu: "windows-1250", hr: "windows-1250",
  sl: "windows-1250", ro: "windows-1250", bs: "windows-1250", sq: "windows-1250",
  // Serbian subtitles in old code pages are mostly written in Latin script.
  sr: "windows-1250",
  ru: "windows-1251", uk: "windows-1251", be: "windows-1251", bg: "windows-1251", mk: "windows-1251",
  el: "windows-1253", grc: "windows-1253",
  tr: "windows-1254",
  he: "windows-1255",
  ar: "windows-1256", fa: "windows-1256",
  lt: "windows-1257", lv: "windows-1257", et: "windows-1257",
  vi: "windows-1258",
  ja: "shift_jis",
  zh: "gb18030",
  ko: "euc-kr"
};

export function decodeImportedTextBytes(
  value: ArrayBuffer | ArrayBufferView,
  language = "pl"
): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const baseLanguage = String(language || "").toLowerCase().split("-")[0];
    return new TextDecoder(LEGACY_ENCODINGS[baseLanguage] || "windows-1252").decode(bytes);
  }
}

function parseSrt(text: string): string {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];

  const isTiming = (line: string | undefined) =>
    /^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test((line || "").trim());
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || isTiming(line)) return;
    // A number is a cue index only right before a timing line; otherwise it
    // is dialogue ("1984").
    if (/^\d+$/.test(line) && isTiming(lines[index + 1])) return;
    output.push(line);
  });

  return joinSubtitleLines(output);
}

function parseVtt(text: string): string {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let skippingBlock = false;
  const isTiming = (line: string | undefined) =>
    /^(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}/.test((line || "").trim());

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      skippingBlock = false;
      continue;
    }
    if (/^WEBVTT($|\s)/i.test(line)) continue;
    if (line === "##") {
      skippingBlock = false;
      continue;
    }
    if (/^(Kind|Language):\s*/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)(:|\s|$)/i.test(line)) {
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) continue;
    if (line.startsWith("::cue") || line === "}") continue;
    // The line right before a timing line is a cue identifier ("intro", "c2", "12").
    if (isTiming(line) || isTiming(lines[index + 1])) continue;
    output.push(line);
  }

  return joinSubtitleLines(output);
}

function parseAss(text: string): string {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inEvents = false;
  let textIndex = 9;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[.+\]$/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    const formatMatch = line.match(/^Format:\s*(.+)$/i);
    if (formatMatch) {
      const columns = formatMatch[1].split(",").map((part) => part.trim().toLowerCase());
      const index = columns.indexOf("text");
      textIndex = index >= 0 ? index : textIndex;
      continue;
    }

    const dialogueMatch = line.match(/^Dialogue:\s*(.+)$/i);
    if (!dialogueMatch) continue;
    const fields = dialogueMatch[1].split(",");
    if (fields.length <= textIndex) continue;
    output.push(fields.slice(textIndex).join(","));
  }

  return joinSubtitleLines(output);
}

export function parseImportedTextFile(file: unknown, rawText: unknown): string {
  const name = stringValue(isRecord(file) ? file.name : "").toLowerCase();
  const text = stringValue(rawText);
  if (name.endsWith(".ass") || name.endsWith(".ssa")) return parseAss(text);
  if (name.endsWith(".srt")) return parseSrt(text);
  if (name.endsWith(".vtt")) return parseVtt(text);
  return stripBom(text).trim();
}

export function titleFromImportedFileName(name: unknown): string {
  return stringValue(name).replace(/\.(txt|md|markdown|srt|vtt|ass|ssa|epub|mobi|azw|azw3)$/i, "");
}
