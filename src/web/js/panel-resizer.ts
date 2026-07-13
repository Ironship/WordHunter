// Shared pointer handling for the app's resizable desktop side panels.
import { state } from "./state.js";

interface SidebarResizerOptions {
  preference: "readerSidebarWidth" | "librarySidebarWidth";
  cssVariable: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  minMainWidth: number;
  sidebarSelector: string;
  overlay?: boolean;
}

export function bindSidebarResizer(resizer: HTMLElement | null | undefined, {
  preference,
  cssVariable,
  defaultWidth,
  minWidth,
  maxWidth,
  minMainWidth,
  sidebarSelector,
  overlay = false
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

  resizer.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    updateOverlayPosition();
    const scale = layout.offsetWidth ? layout.getBoundingClientRect().width / layout.offsetWidth : 1;
    const measuredWidth = sidebar && scale ? sidebar.getBoundingClientRect().width / scale : 0;
    const startWidth = measuredWidth || Number(state.preferences?.[preference]) || defaultWidth;
    const startX = event.clientX;
    const gap = Number.parseFloat(getComputedStyle(layout).columnGap) || 0;
    const gutterWidth = overlay ? 0 : resizer.offsetWidth;
    const gapCount = overlay ? 1 : 2;
    const availableWidth = layout.offsetWidth - minMainWidth - gutterWidth - gap * gapCount;
    const currentMax = Math.min(maxWidth, Math.max(minWidth, availableWidth));

    document.body.classList.add("is-resizing-panel");
    const resize = (move: PointerEvent) => {
      const width = Math.min(currentMax, Math.max(minWidth, startWidth - (move.clientX - startX) / scale));
      document.documentElement.style.setProperty(cssVariable, `${width}px`);
      state.preferences[preference] = width;
      updateOverlayPosition();
    };
    const stop = () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  });
}
