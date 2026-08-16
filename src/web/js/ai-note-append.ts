/**
 * Shared "append a finished AI explanation to the word's note" logic, used by
 * both the reader word panel and the flashcards review card so both flows
 * persist notes identically (append-only, dedupe, pending-save flush).
 *
 * Safety properties (from the data-loss audit):
 * - Any pending debounced field save is flushed FIRST (the global debouncer
 *   keeps a single slot — otherwise a pending translation/note save could be
 *   clobbered by this write, or clobber it), then the note is written through
 *   the canonical `updateWordField` → `saveState` path and the visible
 *   textarea is synced. No synthetic `input` event is dispatched.
 * - Dedupe: skipped when the note already CONTAINS this exact block (any
 *   "<label>:\n<text>" occurrence), so a repeat click (cache hit) never
 *   duplicates, while genuinely new explanations for other contexts still
 *   accumulate.
 * - The current text is read from the live note textarea when one exists
 *   (reader panel) so user-typed unsaved text is never dropped.
 *
 * Returns the new note value (or the unchanged one when nothing was appended)
 * so callers can sync visible UI without re-reading state.
 */
import { state } from "./state.js";
import { t } from "./i18n.js";
import { getOrCreateEntry } from "./views/vocabulary.js";
import { updateWordField } from "./vocab-actions.js";

export function appendAiExplanationToNote(word: string, explanation: string): string {
  const trimmed = String(explanation || "").trim();
  // Defensive no-op: never create a sparse entry just for an empty
  // explanation (the original reader behavior). An existing note is
  // returned so callers can still sync visible UI.
  if (!trimmed) return state.vocab[word]?.note || "";
  // The reader panel textarea is only a live editor while the reader view is
  // actually open. In every other view the hidden panel is stale: reading it
  // could clobber a newer note, and re-scheduling the shared pending-save
  // slot could clobber an unrelated pending field save.
  const field = state.currentView === "reader"
    ? document.querySelector<HTMLTextAreaElement>(
        `#word-panel [data-word-field="note"][data-word="${CSS.escape(word)}"]`
      )
    : null;
  const current = field ? field.value : getOrCreateEntry(word).note || "";
  const trimmedEscaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The marker line is localized; the dedupe must also survive UI language
  // switches AND the user appending their own text after the marker block —
  // so any "<label>:\n<text>" occurrence counts as an existing append.
  if (new RegExp(`(?:^|\n)[^\n]+:\n${trimmedEscaped}`).test(current)) return current;
  const marker = `${t("reader.aiNoteMarker")}:\n${trimmed}`;
  const next = current ? `${current}\n\n${marker}` : marker;
  // Flush pending debounced saves before overwriting. The global debouncer
  // keeps a SINGLE slot, so when we are about to write a note we re-schedule
  // this word's note slot from the live value and flush immediately — the
  // pending write can neither clobber the canonical write below nor be
  // clobbered by it.
  const pendingApi = window as Window & {
    flushWordFieldSave?: () => void;
    scheduleWordFieldSave?: (word: string, field: string, value: string) => void;
  };
  if (pendingApi.scheduleWordFieldSave && field) {
    // Re-write the pending note slot from the live textarea (current + marker
    // is what we are about to persist), then flush — one canonical write.
    pendingApi.scheduleWordFieldSave(word, "note", next);
    pendingApi.flushWordFieldSave?.();
  } else {
    pendingApi.flushWordFieldSave?.();
  }
  if (field) field.value = next;
  updateWordField(word, "note", next);
  return next;
}
