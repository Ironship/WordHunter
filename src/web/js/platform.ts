// @ts-check

import { t } from "./i18n.js";

const MOBILE_IMPORT_ACCEPT = ".txt,.md,.markdown,.srt,.vtt,.ass,.ssa,.epub,.pdf,text/plain,text/markdown,text/vtt,application/epub+zip,application/pdf";
type PocketWordSheetState = "collapsed" | "expanded" | "custom";

export function resolvePocketWordSheetState(
  deltaY: number,
  releaseVelocityY: number,
  currentTop: number,
  expandedTop: number,
  collapsedTop: number
): PocketWordSheetState {
  if (Math.abs(deltaY) >= 12 && Math.abs(releaseVelocityY) >= 0.35) {
    return releaseVelocityY < 0 ? "expanded" : "collapsed";
  }
  if (currentTop <= expandedTop + 8) return "expanded";
  if (currentTop >= collapsedTop - 8) return "collapsed";
  return "custom";
}

export function detectPlatform(): "android" | "desktop" {
  const query = new URLSearchParams(window.location.search);
  const forced = query.get("platform");
  const isAndroid = forced === "android" || "WordHunterAndroid" in window || /\bAndroid\b/i.test(navigator.userAgent || "");
  const platform = isAndroid ? "android" : "desktop";
  document.documentElement.dataset.platform = platform;
  document.documentElement.classList.toggle("pocket-mode", isAndroid);
  return platform;
}

export function isAndroidPlatform(): boolean {
  return document.documentElement.dataset.platform === "android";
}

export function openAndroidUrl(url: string): boolean {
  const opener = window.WordHunterAndroid?.openUrl;
  if (typeof opener !== "function") return false;
  try {
    return opener.call(window.WordHunterAndroid, url) === true;
  } catch (error) {
    console.warn("Failed to open Android URL", error);
    return false;
  }
}

export function applyPlatformUi(): void {
  if (!isAndroidPlatform()) detectPlatform();
  if (!isAndroidPlatform()) return;

  document.documentElement.style.setProperty("--ui-scale", "1");
  document.documentElement.style.zoom = "1";
  bindPocketNavigationDrawer();
  bindPocketImportDrawer();
  refreshPocketWordPanelSheet();

  const importFile = document.getElementById("import-file");
  if (importFile) importFile.setAttribute("accept", MOBILE_IMPORT_ACCEPT);

  const importHint = document.getElementById("import-file-hint");
  if (importHint) importHint.innerHTML = t("import.mobileFileHint");

  const provider = document.getElementById("pref-translation-provider");
  provider?.querySelectorAll<HTMLOptionElement>('option[value="offline"], option[value="lmstudio"]').forEach((option) => {
    option.disabled = true;
    option.hidden = true;
  });
}

export function refreshPocketWordPanelSheet(): void {
  if (isAndroidPlatform()) bindPocketWordPanelSheet();
}

function bindPocketWordPanelSheet(): void {
  const root = document.documentElement;
  const handle = document.getElementById("pocket-word-panel-sheet-handle");
  const wrapper = document.querySelector<HTMLElement>("#reader-view .reader-sidebar-wrapper");
  if (!handle || !wrapper) return;

  const currentState = (): PocketWordSheetState => {
    if (wrapper.dataset.pocketSheetState === "expanded") return "expanded";
    if (wrapper.dataset.pocketSheetState === "custom") return "custom";
    return "collapsed";
  };
  const setState = (
    state: PocketWordSheetState,
    customTop?: number,
    expandedTop?: number,
    collapsedTop?: number
  ): void => {
    wrapper.dataset.pocketSheetState = state;
    root.dataset.pocketWordSheetState = state;
    if (state === "custom") {
      if (Number.isFinite(customTop)) wrapper.style.setProperty("--pocket-word-sheet-top", `${customTop}px`);
      if (Number.isFinite(customTop) && Number.isFinite(expandedTop) && Number.isFinite(collapsedTop)) {
        const range = Math.max(1, collapsedTop - expandedTop);
        const progress = Math.max(0, Math.min(1, (customTop - expandedTop) / range));
        root.dataset.pocketWordSheetProgress = String(progress);
      }
    } else {
      wrapper.style.removeProperty("--pocket-word-sheet-top");
      delete root.dataset.pocketWordSheetProgress;
    }
    const expanded = state !== "collapsed";
    const label = t(expanded ? "reader.collapseWordPanel" : "reader.expandWordPanel");
    handle.setAttribute("aria-expanded", String(expanded));
    handle.setAttribute("aria-label", label);
    handle.setAttribute("title", label);
  };

  interface SheetDrag {
    pointerId: number;
    startX: number;
    startY: number;
    startTop: number;
    currentTop: number;
    expandedTop: number;
    collapsedTop: number;
    lastY: number;
    lastAt: number;
    velocityY: number;
    maxTravel: number;
    startState: PocketWordSheetState;
  }

  let drag: SheetDrag | null = null;
  let suppressClickUntil = 0;
  const measureTop = (state: PocketWordSheetState): number => {
    const original = currentState();
    wrapper.dataset.pocketSheetState = state;
    const top = wrapper.getBoundingClientRect().top;
    wrapper.dataset.pocketSheetState = original;
    return top;
  };
  const restoreState = (): void => {
    const remembered = root.dataset.pocketWordSheetState;
    if (remembered !== "custom") {
      setState(remembered === "expanded" ? "expanded" : currentState());
      return;
    }
    if (!root.classList.contains("pocket-word-panel-open") || !root.classList.contains("has-selected-word")) {
      setState("custom");
      return;
    }
    wrapper.classList.add("pocket-word-sheet-measuring");
    const expandedTop = measureTop("expanded");
    const collapsedTop = measureTop("collapsed");
    wrapper.classList.remove("pocket-word-sheet-measuring");
    const progress = Math.max(0, Math.min(1, Number(root.dataset.pocketWordSheetProgress) || 0));
    setState("custom", expandedTop + (collapsedTop - expandedTop) * progress, expandedTop, collapsedTop);
  };
  const finishDrag = (
    state: PocketWordSheetState,
    top?: number,
    expandedTop?: number,
    collapsedTop?: number
  ): void => {
    setState(state, top, expandedTop, collapsedTop);
    wrapper.classList.remove("pocket-word-sheet-dragging", "pocket-word-sheet-measuring");
    drag = null;
  };

  restoreState();
  if (root.dataset.pocketWordSheetBound === "true") return;
  root.dataset.pocketWordSheetBound = "true";

  handle.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    setState(currentState() === "collapsed" ? "expanded" : "collapsed");
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setState(event.key === "ArrowUp" ? "expanded" : "collapsed");
  });
  handle.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const startState = currentState();
    wrapper.classList.add("pocket-word-sheet-measuring");
    const expandedTop = measureTop("expanded");
    const collapsedTop = measureTop("collapsed");
    const startTop = wrapper.getBoundingClientRect().top;
    wrapper.classList.remove("pocket-word-sheet-measuring");
    const startedAt = performance.now();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTop,
      currentTop: startTop,
      expandedTop,
      collapsedTop,
      lastY: event.clientY,
      lastAt: startedAt,
      velocityY: 0,
      maxTravel: 0,
      startState
    };
    wrapper.style.setProperty("--pocket-word-sheet-top", `${startTop}px`);
    wrapper.classList.add("pocket-word-sheet-dragging");
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const now = performance.now();
    drag.velocityY = (event.clientY - drag.lastY) / Math.max(1, now - drag.lastAt);
    drag.lastY = event.clientY;
    drag.lastAt = now;
    drag.maxTravel = Math.max(drag.maxTravel, Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY));
    const nextTop = Math.max(drag.expandedTop, Math.min(drag.collapsedTop, drag.startTop + event.clientY - drag.startY));
    drag.currentTop = nextTop;
    wrapper.style.setProperty("--pocket-word-sheet-top", `${nextTop}px`);
  });
  handle.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const activeDrag = drag;
    handle.releasePointerCapture?.(event.pointerId);
    const deltaY = event.clientY - activeDrag.startY;
    activeDrag.maxTravel = Math.max(activeDrag.maxTravel, Math.hypot(event.clientX - activeDrag.startX, deltaY));
    const now = performance.now();
    if (event.clientY !== activeDrag.lastY) {
      activeDrag.velocityY = (event.clientY - activeDrag.lastY) / Math.max(1, now - activeDrag.lastAt);
    } else if (now - activeDrag.lastAt > 100) {
      activeDrag.velocityY = 0;
    }
    activeDrag.currentTop = Math.max(
      activeDrag.expandedTop,
      Math.min(activeDrag.collapsedTop, activeDrag.startTop + deltaY)
    );
    if (activeDrag.maxTravel < 8) {
      finishDrag(
        activeDrag.startState,
        activeDrag.startTop,
        activeDrag.expandedTop,
        activeDrag.collapsedTop
      );
      return;
    }
    suppressClickUntil = performance.now() + 400;
    event.preventDefault();
    const nextState = resolvePocketWordSheetState(
      deltaY,
      activeDrag.velocityY,
      activeDrag.currentTop,
      activeDrag.expandedTop,
      activeDrag.collapsedTop
    );
    finishDrag(
      nextState,
      activeDrag.currentTop,
      activeDrag.expandedTop,
      activeDrag.collapsedTop
    );
  });
  handle.addEventListener("pointercancel", () => {
    if (drag) finishDrag(drag.startState, drag.startTop, drag.expandedTop, drag.collapsedTop);
  });
  window.addEventListener("resize", () => {
    if (drag) finishDrag(drag.startState, drag.startTop, drag.expandedTop, drag.collapsedTop);
    else restoreState();
  });
}

function bindPocketNavigationDrawer(): void {
  const root = document.documentElement;
  if (root.dataset.pocketNavigationDrawerBound === "true") return;
  const panel = document.getElementById("app-navigation");
  const toggles = [
    document.getElementById("pocket-navigation-toggle"),
    document.getElementById("reader-pocket-navigation-toggle")
  ].filter((toggle) => toggle !== null);
  if (!panel || !toggles.length) return;
  root.dataset.pocketNavigationDrawerBound = "true";

  const setOpen = (open: boolean) => {
    root.classList.toggle("pocket-navigation-open", open);
    toggles.forEach((toggle) => toggle.setAttribute("aria-expanded", String(open)));
  };

  toggles.forEach((toggle) => {
    toggle.addEventListener("click", () => setOpen(!root.classList.contains("pocket-navigation-open")));
  });
  document.querySelectorAll?.(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setOpen(false));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.classList.contains("pocket-navigation-open")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#app-navigation, #pocket-navigation-toggle, #reader-pocket-navigation-toggle")) return;
    setOpen(false);
  });
}

function bindPocketImportDrawer(): void {
  const root = document.documentElement;
  if (root.dataset.pocketImportDrawerBound === "true") return;
  const panel = document.querySelector(".import-panel");
  const openButton = document.getElementById("library-import-toggle");
  const closeButton = document.getElementById("library-import-close");
  if (!panel || !openButton) return;
  root.dataset.pocketImportDrawerBound = "true";

  const setOpen = (open: boolean) => {
    root.classList.toggle("pocket-import-open", open);
    openButton.setAttribute("aria-expanded", String(open));
  };
  const isLibraryActive = () => Boolean(document.querySelector("#library-view.active"));

  openButton.addEventListener("click", () => setOpen(!root.classList.contains("pocket-import-open")));
  closeButton?.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.classList.contains("pocket-import-open")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".import-panel, #library-import-toggle")) return;
    setOpen(false);
  });

  let startX = 0;
  let startY = 0;
  let tracking = false;
  const beginSwipe = (clientX: number, clientY: number) => {
    if (!isLibraryActive()) return;
    const open = root.classList.contains("pocket-import-open");
    if (!open && clientX < window.innerWidth - 72) return;
    startX = clientX;
    startY = clientY;
    tracking = true;
  };
  const finishSwipe = (clientX: number, clientY: number) => {
    if (!tracking) return;
    tracking = false;
    const dx = clientX - startX;
    if (Math.abs(dx) < 60 || Math.abs(clientY - startY) > 80) return;
    const open = root.classList.contains("pocket-import-open");
    if (!open && dx < 0) setOpen(true);
    if (open && dx > 0) setOpen(false);
  };
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") beginSwipe(event.clientX, event.clientY);
  }, { passive: true });
  document.addEventListener("pointerup", (event) => {
    finishSwipe(event.clientX, event.clientY);
  }, { passive: true });
  document.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    if (touch) beginSwipe(touch.clientX, touch.clientY);
  }, { passive: true });
  document.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0];
    if (touch) finishSwipe(touch.clientX, touch.clientY);
  }, { passive: true });
}
