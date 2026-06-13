function normalizeSubtitleText(value) {
  return String(value || "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinSubtitleLines(lines) {
  return lines
    .map(normalizeSubtitleText)
    .filter(Boolean)
    .filter((line, index, all) => line !== all[index - 1])
    .join("\n");
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function parseSrt(text) {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(line)) continue;
    output.push(line);
  }

  return joinSubtitleLines(output);
}

function parseVtt(text) {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let skippingBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      skippingBlock = false;
      continue;
    }
    if (/^WEBVTT($|\s)/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)($|\s)/i.test(line)) {
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3}/.test(line)) continue;
    output.push(line);
  }

  return joinSubtitleLines(output);
}

function parseAss(text) {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
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

export function parseImportedTextFile(file, rawText) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".ass") || name.endsWith(".ssa")) return parseAss(rawText);
  if (name.endsWith(".srt")) return parseSrt(rawText);
  if (name.endsWith(".vtt")) return parseVtt(rawText);
  return stripBom(rawText).trim();
}

export function titleFromImportedFileName(name) {
  return String(name || "").replace(/\.(txt|md|markdown|srt|vtt|ass|ssa|epub|mobi|azw|azw3)$/i, "");
}
