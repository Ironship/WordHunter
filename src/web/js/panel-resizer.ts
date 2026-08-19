// Shared pointer + keyboard handling for the app's resizable desktop side panels.
import { state, saveState } from "./state.js";

interface SidebarResizerOptions {
  preference: "readerSidebarWidth" | "librarySidebarWidth";
  cssVariable: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  minMainWidth: number;
  sidebarSelector: string;
  overlay?: boolean;
  /** Keyboard step for Arrow Left/Right (px). */
  step?: number;
}

export function bindSidebarResizer(resizer: HTMLElement | null | undefined, {
  preference,
  cssVariable,
  defaultWidth,
  minWidth,
  maxWidth,
  minMainWidth,
  sidebarSelector,
  overlay = false,
  step = 16
}: SidebarResizerOptions): void {
  if (!resizer || resizer.dataset.resizerBound) return;
  resizer.dataset.resizerBound = "true";

  const layout = resizer.parentElement;
  const sidebar = sidebarSelector ? layout.querySelector<HTMLElement>(sidebarSelector) : null;
  const updateOverlayPosition = () => {
    if (!overlay || !sidebar) return;
    const layoutRect = layout.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const scale = layout.offsetWidth ? layoutRect.width / layout.offsetWidth : 1;
    if (!layoutRect.width || !sidebarRect.width || !scale) return;
    resizer.style.left = `${(sidebarRect.left - layoutRect.left) / scale - 4}px`;
  };

  if (overlay && window.ResizeObserver) {
    const observer = new ResizeObserver(updateOverlayPosition);
    observer.observe(layout);
  }
  requestAnimationFrame(updateOverlayPosition);

  // Make the separator keyboard-operable (WAI-ARIA separator pattern): it is
  // a single tab stop with an accessible name and value range; Arrow Left /
  // Right resize by `step` px, Home reaches the minimum, End the maximum.
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.tabIndex = 0;
  resizer.setAttribute("aria-valuemin", String(Math.round(minWidth)));
  resizer.setAttribute("aria-valuemax", String(Math.round(maxWidth)));
  resizer.setAttribute("aria-valuenow", String(Math.round(currentWidth())));

  /** Applied width: the persisted preference or the configured default. */
  function currentWidth(): number {
    const stored = Number(state.preferences?.[preference]);
    return Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
  }

  /** Effective maximum for the current viewport: configured max capped by the
   *  free space after the main column and gutters. */
  function effectiveMaxWidth(): number {
    if (!layout) return maxWidth;
    const gap = typeof getComputedStyle === "function"
      ? (Number.parseFloat(getComputedStyle(layout).columnGap) || 0)
      : 0;
    const gutterWidth = overlay ? 0 : resizer.offsetWidth;
    const gapCount = overlay ? 1 : 2;
    const availableWidth = layout.offsetWidth - minMainWidth - gutterWidth - gap * gapCount;
    const safeMax = Number.isFinite(availableWidth) ? availableWidth : maxWidth;
    return Math.max(minWidth, Math.min(maxWidth, safeMax));
  }

  /** Clamp + apply a width: CSS variable, persisted preference, live ARIA. */
  function applyWidth(width: number, persist = true): void {
    const clamped = Math.max(minWidth, Math.min(effectiveMaxWidth(), Math.round(width)));
    document.documentElement.style.setProperty(cssVariable, `${clamped}px`);
    if (persist) state.preferences[preference] = clamped;
    resizer.setAttribute("aria-valuenow", String(clamped));
    resizer.setAttribute("aria-valuemax", String(Math.round(effectiveMaxWidth())));
    updateOverlayPosition();
  }

  resizer.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    updateOverlayPosition();
    const scale = layout.offsetWidth ? layout.getBoundingClientRect().width / layout.offsetWidth : 1;
    const measuredWidth = sidebar && scale ? sidebar.getBoundingClientRect().width / scale : 0;
    const startWidth = measuredWidth || currentWidth();
    const startX = event.clientX;

    document.body.classList.add("is-resizing-panel");
    const resize = (move: PointerEvent) => {
      applyWidth(startWidth - (move.clientX - startX) / scale, true);
    };
    const stop = () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      // Persist the chosen panel width so it survives restarts.
      saveState();
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  });

  resizer.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    const handle = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === "arrowleft") {
      handle();
      applyWidth(currentWidth() - step, true);
    } else if (key === "arrowright") {
      handle();
      applyWidth(currentWidth() + step, true);
    } else if (key === "home") {
      handle();
      applyWidth(minWidth, true);
    } else if (key === "end") {
      handle();
      applyWidth(effectiveMaxWidth(), true);
    }
  });
}
