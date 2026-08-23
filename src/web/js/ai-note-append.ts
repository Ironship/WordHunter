/**
 * Shared "persist a finished AI explanation into the word's note" logic, used
 * by both the reader word panel and the flashcards review card so both flows
 * store notes identically.
 *
 * Safety properties (from the data-loss audit):
 * - Any pending debounced field save is flushed FIRST (the global debouncer
 *   keeps a single slot — otherwise a pending translation/note save could be
 *   clobbered by this write, or clobber it), then the note is written through
 *   the canonical `updateWordField` → `saveState` path and the visible
 *   textarea is synced. No synthetic `input` event is dispatched.
 * - Dedupe: skipped when the note already CONTAINS this exact block (any
 *   "<label>:\n<text>" occurrence), so a repeat click (cache hit) never
 *   duplicates.
 * - The current text is read from the live note textarea when one exists
 *   (reader panel) so user-typed unsaved text is never dropped.
 *
 * When the note already holds other text, `persistAiExplanationToNote` asks
 * the user whether to APPEND the explanation or REPLACE the whole note; Cancel
 * leaves the note untouched (rc.6: repeated explanations no longer clutter
 * the note silently).
 */
import { state } from "./state.js";
import { t } from "./i18n.js";
import { getOrCreateEntry } from "./views/vocabulary.js";
import { updateWordField } from "./vocab-actions.js";
import { showChoiceDialog } from "./dialog-backdrop.js";

export type AiNoteWriteMode = "append" | "replace";

/** Live reader textarea for this word while the reader view is open, else null. */
function liveNoteField(word: string): HTMLTextAreaElement | null {
  // The reader panel textarea is only a live editor while the reader view is
  // actually open. In every other view the hidden panel is stale: reading it
  // could clobber a newer note.
  return state.currentView === "reader"
    ? document.querySelector<HTMLTextAreaElement>(
        `#word-panel [data-word-field="note"][data-word="${CSS.escape(word)}"]`
      )
    : null;
}

export function currentAiNoteText(word: string): string {
  const field = liveNoteField(word);
  return field ? field.value : getOrCreateEntry(word).note || "";
}

function hasExplanationBlock(noteText: string, trimmed: string): boolean {
  const trimmedEscaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The marker line is localized; the dedupe must also survive UI language
  // switches AND the user appending their own text after the marker block —
  // so any "<label>:\n<text>" occurrence counts as an existing append.
  return new RegExp(`(?:^|\n)[^\n]+:\n${trimmedEscaped}`).test(noteText);
}

function writeAiNote(word: string, explanation: string, mode: AiNoteWriteMode): string {
  const trimmed = String(explanation || "").trim();
  const field = liveNoteField(word);
  const current = field ? field.value : getOrCreateEntry(word).note || "";
  if (!trimmed) return current;
  const marker = `${t("reader.aiNoteMarker")}:\n${trimmed}`;
  const next = mode === "replace" ? marker : current ? `${current}\n\n${marker}` : marker;
  // Flush pending debounced saves FIRST. The global debouncer keeps a SINGLE
  // slot — re-scheduling it here would silently drop an unrelated pending
  // field save. A plain flush applies any pending edit, then the canonical
  // write below wins for this note.
  const pendingApi = window as Window & {
    flushWordFieldSave?: () => void;
  };
  pendingApi.flushWordFieldSave?.();
  if (field) field.value = next;
  updateWordField(word, "note", next);
  return next;
}

/**
 * Interactive persistence used after an AI explanation finishes:
 * - empty explanation → no-op,
 * - exact duplicate block → no-op (dedupe),
 * - empty note → silent append,
 * - non-empty note → Append / Replace / Cancel dialog (Cancel writes nothing).
 * Returns the resulting note value so callers can sync visible UI without
 * re-reading state.
 */
export async function persistAiExplanationToNote(word: string, explanation: string): Promise<string> {
  const trimmed = String(explanation || "").trim();
  if (!trimmed) return currentAiNoteText(word);
  const current = currentAiNoteText(word);
  if (hasExplanationBlock(current, trimmed)) return current;
  let mode: AiNoteWriteMode = "append";
  if (current.trim()) {
    const choice = await showChoiceDialog({
      title: t("reader.aiNoteChoiceTitle"),
      message: t("reader.aiNoteChoiceMessage"),
      options: [
        { id: "cancel", label: t("dialog.cancel"), style: "secondary" },
        { id: "replace", label: t("reader.aiNoteReplace"), style: "danger" },
        { id: "append", label: t("reader.aiNoteAppend"), style: "primary" }
      ]
    });
    if (choice === "cancel" || choice === null) return current;
    if (choice === "replace") mode = "replace";
  }
  return writeAiNote(word, trimmed, mode);
}
