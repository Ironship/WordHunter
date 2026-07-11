import { t } from "./i18n.js";

const MOBILE_IMPORT_ACCEPT = ".txt,.md,.markdown,.srt,.vtt,.ass,.ssa,.epub,.pdf,text/plain,text/markdown,text/vtt,application/epub+zip,application/pdf";

export function detectPlatform() {
  const query = new URLSearchParams(window.location.search);
  const forced = query.get("platform");
  const isAndroid = forced === "android" || "WordHunterAndroid" in window || /\bAndroid\b/i.test(navigator.userAgent || "");
  const platform = isAndroid ? "android" : "desktop";
  document.documentElement.dataset.platform = platform;
  document.documentElement.classList.toggle("pocket-mode", isAndroid);
  return platform;
}

export function isAndroidPlatform() {
  return document.documentElement.dataset.platform === "android";
}

export function openAndroidUrl(url) {
  const opener = window.WordHunterAndroid?.openUrl;
  if (typeof opener !== "function") return false;
  try {
    return opener.call(window.WordHunterAndroid, url) === true;
  } catch (error) {
    console.warn("Failed to open Android URL", error);
    return false;
  }
}

export function applyPlatformUi() {
  if (!isAndroidPlatform()) detectPlatform();
  if (!isAndroidPlatform()) return;

  document.documentElement.style.setProperty("--ui-scale", "1");
  document.documentElement.style.zoom = "1";
  bindPocketNavigationDrawer();
  bindPocketImportDrawer();

  const importFile = document.getElementById("import-file");
  if (importFile) importFile.setAttribute("accept", MOBILE_IMPORT_ACCEPT);

  const importHint = document.getElementById("import-file-hint");
  if (importHint) importHint.innerHTML = t("import.mobileFileHint");

  const provider = document.getElementById("pref-translation-provider");
  provider?.querySelectorAll('option[value="offline"], option[value="lmstudio"]').forEach((option) => {
    option.disabled = true;
    option.hidden = true;
  });
}

function bindPocketNavigationDrawer() {
  const root = document.documentElement;
  if (root.dataset.pocketNavigationDrawerBound === "true") return;
  const panel = document.getElementById("app-navigation");
  const toggles = [
    document.getElementById("pocket-navigation-toggle"),
    document.getElementById("reader-pocket-navigation-toggle")
  ].filter(Boolean);
  if (!panel || !toggles.length) return;
  root.dataset.pocketNavigationDrawerBound = "true";

  const setOpen = (open) => {
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

function bindPocketImportDrawer() {
  const root = document.documentElement;
  if (root.dataset.pocketImportDrawerBound === "true") return;
  const panel = document.querySelector(".import-panel");
  const openButton = document.getElementById("library-import-toggle");
  const closeButton = document.getElementById("library-import-close");
  if (!panel || !openButton) return;
  root.dataset.pocketImportDrawerBound = "true";

  const setOpen = (open) => {
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
  const beginSwipe = (clientX, clientY) => {
    if (!isLibraryActive()) return;
    const open = root.classList.contains("pocket-import-open");
    if (!open && clientX < window.innerWidth - 72) return;
    startX = clientX;
    startY = clientY;
    tracking = true;
  };
  const finishSwipe = (clientX, clientY) => {
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
