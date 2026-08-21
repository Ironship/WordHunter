/**
 * Markdown-lite inline formatting for book texts: **bold**, *italic*.
 *
 * Design contract (offset safety): markers are STRIPPED before tokenization,
 * and the returned spans are expressed in the STRIPPED-text coordinate
 * system. Everything downstream of tokenizeText — globalCharOffsets, TTS
 * sentence extraction, in-text review positions — therefore keeps working
 * unchanged, because it never sees the marker characters. The reader maps
 * spans onto rendered tokens; vocab identity is unaffected since marker
 * characters never reach word tokens.
 */

export type WhFormatSpanKind = "bold" | "italic";

export interface WhFormatSpan {
  start: number;
  end: number;
  kind: WhFormatSpanKind;
}

export interface WhStrippedFormat {
  plain: string;
  spans: WhFormatSpan[];
}

interface MarkerRule {
  pattern: RegExp;
  kind: WhFormatSpanKind;
}

/** Line-content scoped, non-greedy; markers cannot span lines. Bold runs
 *  before italic so `**x**` is never mis-parsed as empty italic. */
const MARKER_RULES: readonly MarkerRule[] = [
  { pattern: /\*\*([^*\n]+)\*\*/g, kind: "bold" },
  { pattern: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, kind: "italic" }
];

/**
 * Strips **bold** / *italic* markers from `text`.
 * Returns the marker-free text plus format spans positioned in THAT stripped
 * text. Unmatched or stray marker characters are left verbatim (they render
 * as literal punctuation, exactly like today).
 */
export function stripFormatMarkers(text: string): WhStrippedFormat {
  if (!text || !text.includes("*")) return { plain: text, spans: [] };
  type Edit = { start: number; end: number; content: string; kind: WhFormatSpanKind };
  const edits: Edit[] = [];
  for (const rule of MARKER_RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match) {
      edits.push({
        start: match.index,
        end: match.index + match[0].length,
        content: match[1],
        kind: rule.kind
      });
      match = rule.pattern.exec(text);
    }
  }
  if (edits.length === 0) return { plain: text, spans: [] };

  // Non-overlapping by construction per rule, but bold+italic rules could
  // overlap on pathological input (`**a *b** c*`): drop any edit that
  // overlaps an already-accepted one (first rule wins), keeping order stable.
  edits.sort((a, b) => a.start - b.start || b.end - a.start - (b.end - b.start));
  const accepted: Edit[] = [];
  let lastEnd = -1;
  for (const edit of edits) {
    if (edit.start >= lastEnd) {
      accepted.push(edit);
      lastEnd = edit.end;
    }
  }

  let plain = "";
  const spans: WhFormatSpan[] = [];
  let cursor = 0;
  for (const edit of accepted) {
    plain += text.slice(cursor, edit.start);
    const spanStart = plain.length;
    plain += edit.content;
    spans.push({ start: spanStart, end: plain.length, kind: edit.kind });
    cursor = edit.end;
  }
  plain += text.slice(cursor);
  return { plain, spans };
}

/** True when `[start, end)` overlaps a span of `kind` (binary search). */
export function spanCovers(spans: readonly WhFormatSpan[], start: number, end: number, kind?: WhFormatSpanKind): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = spans[mid];
    if (span.end <= start) low = mid + 1;
    else if (span.start >= end) high = mid - 1;
    else return kind === undefined || span.kind === kind;
  }
  return false;
}
