/**
 * AI explanation for the flashcards (review card): streams the explanation
 * into the card's output box. Kept separate from word-panel so the flashcard
 * flow can reuse the shared explainer without coupling to the reader panel.
 */
import { state } from "../state.js";
import { aiExplanationConfigured, aiExplanationLanguagePair, explainWord, formatAiExplanation } from "../ai-explainer.js";
import { appendAiExplanationToNote } from "../ai-note-append.js";
import { beginElementBusy } from "../loading.js";
import { t } from "../i18n.js";

export async function runReviewCardAiExplain(
  button: HTMLButtonElement,
  word: string
): Promise<void> {
  const card = button.closest("#review-card");
  const output = card?.querySelector<HTMLElement>("[data-review-ai-explanation]");
  if (!output) return;
  if (!aiExplanationConfigured()) {
    output.hidden = false;
    output.textContent = t("reader.aiExplainNotConfigured");
    return;
  }
  // Context is resolved from the vocabulary entry (never from DOM attributes:
  // the reverse card must not leak the headword into the markup).
  const entry = state.vocab?.[word];
  const context = Array.isArray(entry?.examples) && entry.examples[0] ? String(entry.examples[0]) : "";
  const releaseBusy = beginElementBusy(button, { disable: true });
  output.hidden = false;
  output.textContent = t("translator.translating");
  try {
    const pair = aiExplanationLanguagePair();
    const result = await explainWord(
      { word, context: context || word, from: pair.from, to: pair.to },
      (text) => {
        // The card re-renders on navigation; only touch a live output box.
        if (output.isConnected) output.innerHTML = formatAiExplanation(text);
      }
    );
    if (output.isConnected) output.innerHTML = formatAiExplanation(result.explanation);
    // Persist the finished explanation to the word's note exactly like the
    // reader word panel does (append-only with dedupe): the card output box
    // alone is ephemeral and the user would pay for a repeated explanation
    // otherwise.
    const nextNote = appendAiExplanationToNote(word, result.explanation);
    // Keep the visible note paragraph in sync when the answer side is
    // showing; a full renderReview() would wipe the streamed explanation
    // box. The note is persisted in state regardless and appears on the
    // next natural re-render (flip/grade).
    if (card?.isConnected) {
      const noteEl = card.querySelector<HTMLElement>(".review-note");
      if (noteEl) noteEl.textContent = nextNote;
    }
  } catch (error) {
    console.warn("AI explanation failed (flashcard)", error);
    if (output.isConnected) output.textContent = t("reader.aiExplainError");
  } finally {
    releaseBusy();
  }
}
