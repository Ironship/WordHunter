import { els } from "../dom.js";

interface FlashcardGesture {
  pointerId: number;
  x: number;
  y: number;
  canReveal: boolean;
}

const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, [contenteditable]";

export function flashcardGestureAction(dx: number, dy: number): "next" | "prev" | null {
  if (Math.abs(dx) < 80 || Math.abs(dy) > 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "next" : "prev";
}

export function bindFlashcardEvents(): void {
  const host = els.reviewCard;
  if (!(host instanceof HTMLElement) || host.dataset.gesturesBound === "true") return;
  host.dataset.gesturesBound = "true";

  let gesture: FlashcardGesture | null = null;
  let suppressClickUntil = 0;

  host.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-review-card-surface]")) return;
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      canReveal: !target.closest(INTERACTIVE_SELECTOR)
    };
  }, { passive: true });

  host.addEventListener("pointerup", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const canReveal = gesture.canReveal;
    gesture = null;

    const action = flashcardGestureAction(dx, dy);
    if (action) {
      const button = host.querySelector<HTMLButtonElement>(action === "next" ? "#btn-flashcard-next" : "#btn-flashcard-prev");
      if (button && !button.disabled) {
        event.preventDefault();
        button.click();
      }
      suppressClickUntil = Date.now() + 400;
      return;
    }

    if (!canReveal || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const card = host.querySelector<HTMLElement>(".flashcard-wrap");
    if (card?.dataset.answerVisible === "true") return;
    const reveal = host.querySelector<HTMLButtonElement>('[data-review-action="toggle"]');
    if (reveal && !reveal.disabled) reveal.click();
  });

  host.addEventListener("pointercancel", () => {
    gesture = null;
  }, { passive: true });

  host.addEventListener("click", (event) => {
    if (Date.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  });
}
