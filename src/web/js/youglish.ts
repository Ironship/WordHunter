import { state } from "./state.js";
type TranslationVars = Record<string, string | number | boolean | null | undefined>;

interface YouGlishFetchEvent {
  totalResult?: number;
}

interface YouGlishWidget {
  fetch(word: string, language: string): void;
  pause(): void;
}

interface YouGlishWidgetOptions {
  width: number;
  components: number;
  backgroundColor?: string;
  events: {
    onFetchDone(event: YouGlishFetchEvent): void;
    onError(event: unknown): void;
  };
}

interface YouGlishApi {
  Widget: new (elementId: string, options: YouGlishWidgetOptions) => YouGlishWidget;
}

type YouGlishWindow = Window & typeof globalThis & {
  YG?: YouGlishApi;
  onYouglishAPIReady?: () => void;
};

const youglishWindow = window as YouGlishWindow;
let youglishWidget: YouGlishWidget | null = null;
let youglishWidgetTheme: "dark" | "light" | null = null;
let youglishLastRequest: { word: string; language: string } | null = null;
let youglishFetchDone = false;

import { showToast } from "./toast.js";
import { t as rawT } from "./i18n.js";
import { resolveTheme } from "./theme.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";

let youglishApiReady = false;
let youglishApiPromise: Promise<void> | null = null;
const YOUGLISH_API_SCRIPT_URL = "https://youglish.com/public/emb/widget.js";
const YOUGLISH_API_TIMEOUT_MS = 12000;
const t = rawT as (key: string, vars?: TranslationVars) => string;

function getYouglishLang(langCode: string): string {
  const map: Record<string, string> = { en: "english", de: "german", es: "spanish", it: "italian", fr: "french", pl: "polish", ru: "russian", uk: "ukrainian", ja: "japanese", zh: "chinese", la: "latin", grc: "greek" };
  return map[langCode] || "english";
}

function youglishPageUrl(word: string): string {
  const ygLang = getYouglishLang(effectiveLearningLanguage(state.preferences));
  return `https://youglish.com/pronounce/${encodeURIComponent(word)}/${encodeURIComponent(ygLang)}`;
}

/**
 * Open the YouGlish page for the word in a top-level window. Per the
 * `youglishMode` preference: "internal" uses the app's internal popup (the
 * same mechanism the dictionary uses), "external" opens the system default
 * browser through the embedded server (plain window.open from an async
 * callback is popup-blocked in the webview).
 */
export function openYouglishSite(word: string): void {
  const url = youglishPageUrl(word);
  const mode = state.preferences.youglishMode || "internal";
  if (mode === "external") {
    fetch(`/__open_external?url=${encodeURIComponent(url)}`).catch((error) =>
      console.warn("Failed to open the browser", error)
    );
    return;
  }
  const popupUrl = `/__open_dict?url=${encodeURIComponent(url)}&mode=internal&title=${encodeURIComponent(t("reader.youglishModalTitle"))}`;
  fetch(popupUrl).catch((error) => console.warn("Failed to open YouGlish popup", error));
}

/**
 * The widget cannot play (YouGlish blocks embedded playback in this
 * environment). Open the word's page right away — internal popup or the
 * system browser, per the YouGlish opening preference — and close the modal.
 */
function handleYouglishUnavailable(word: string): void {
  youglishWidget = null;
  youglishWidgetTheme = null;
  openYouglishSite(word);
  showToast(t("reader.youglishOpenedSite"));
  closeYouGlish();
}

function initYouglish(): boolean {
  const Widget = youglishWindow.YG?.Widget;
  if (!Widget) return false;
  const isDark = resolveTheme(state.preferences.theme, document.documentElement.dataset.theme === "dark").mode === "dark";
  const theme = isDark ? "dark" : "light";
  if (youglishWidget && youglishWidgetTheme === theme) return false;
  if (youglishWidget) {
    youglishWidget.pause();
    youglishWidget = null;
    document.getElementById("youglish-widget")?.replaceChildren();
  }
  const w = Math.min(640, window.innerWidth - 64);
  youglishWidget = new Widget("youglish-widget", {
    width: w,
    components: 9,
    // Documented widget option (data-bkg-color): the old `theme` option the
    // app passed before is not read by the widget at all.
    backgroundColor: isDark ? "theme_dark" : "theme_light",
    events: {
      'onFetchDone': (e) => {
        youglishFetchDone = true;
        if (e && e.totalResult === 0) {
          showToast(t("toast.youglishNoResults"));
        }
      },
      'onError': (_event) => {
        // YouGlish currently kills embedded playback; a widget that never
        // produced results is dead — open the working fallback instead of
        // leaving an empty modal. Once results arrived, errors are
        // transient and the player keeps working.
        if (youglishFetchDone) return;
        const word = youglishLastRequest?.word || "";
        handleYouglishUnavailable(word);
      }
    }
  });
  youglishWidgetTheme = theme;
  return true;
}

youglishWindow.onYouglishAPIReady = () => {
  youglishApiReady = true;
};

/**
 * Load the YouGlish widget script exactly once. Never leaves the caller
 * hanging: a stale/failed script element is removed and rejected (with a
 * timeout), so the next open retries with a fresh script.
 */
function loadYouglishApi(): Promise<void> {
  if (youglishWindow.YG?.Widget) {
    youglishApiReady = true;
    return Promise.resolve();
  }
  if (youglishApiPromise) return youglishApiPromise;

  youglishApiPromise = new Promise<void>((resolve, reject) => {
    const previousReady = youglishWindow.onYouglishAPIReady;
    youglishWindow.onYouglishAPIReady = () => {
      previousReady?.();
      youglishApiReady = true;
      resolve();
    };

    const script = document.createElement("script");
    script.async = true;
    script.charset = "utf-8";
    script.src = YOUGLISH_API_SCRIPT_URL;
    script.dataset.youglishApi = "true";
    let timer = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("youglish API unavailable"));
    };
    script.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (youglishWindow.YG?.Widget) {
        youglishApiReady = true;
        resolve();
      } else {
        // The script executed but the API never initialized (blocked or
        // rewritten response) — drop it so the next open retries fresh.
        script.remove();
        reject(new Error("youglish API unavailable"));
      }
    }, { once: true });
    script.addEventListener("error", fail, { once: true });
    timer = window.setTimeout(fail, YOUGLISH_API_TIMEOUT_MS);
    // Remove any stale previous attempt before injecting a fresh script.
    document.querySelectorAll('script[data-youglish-api="true"]').forEach((el) => el.remove());
    document.head.appendChild(script);
  }).catch((error) => {
    // Allow a retry on the next open.
    youglishApiPromise = null;
    throw error;
  });

  return youglishApiPromise;
}

async function fetchYouGlish(word: string): Promise<void> {
  try {
    await loadYouglishApi();
  } catch (error) {
    console.warn("YouGlish API unavailable", error);
    handleYouglishUnavailable(word);
    return;
  }
  if (youglishWindow.YG?.Widget) {
    youglishApiReady = true;
    initYouglish();
  }
  const ygLang = getYouglishLang(effectiveLearningLanguage(state.preferences));
  if (youglishWidget) {
    youglishLastRequest = { word, language: ygLang };
    youglishFetchDone = false;
    youglishWidget.fetch(word, ygLang);
  } else {
    handleYouglishUnavailable(word);
  }
}

export function openYouGlish(word: string): void {
  const modal = document.getElementById("youglish-modal") as HTMLDialogElement | null;
  const modalBody = document.getElementById("youglish-modal-body");

  if (modalBody) {
    const widgetHost = document.getElementById("youglish-widget");
    if (widgetHost?.parentNode !== modalBody) {
      modalBody.innerHTML = `<div id="youglish-widget"></div>`;
      youglishWidget = null;
      youglishWidgetTheme = null;
      if (youglishApiReady) {
        initYouglish();
      }
    } else if (!youglishWidget && youglishApiReady) {
      initYouglish();
    }
  }

  if (modal) {
    if (!modal.open) modal.showModal();
  }
  fetchYouGlish(word);
}

export function closeYouGlish() {
  const modal = document.getElementById("youglish-modal") as HTMLDialogElement | null;
  if (modal) modal.close();
  if (youglishWidget) {
    youglishWidget.pause();
  }
}

export function refreshYouGlishTheme(): void {
  const recreated = youglishWidget ? initYouglish() : false;
  if (recreated && youglishWidget && youglishLastRequest) {
    youglishWidget.fetch(youglishLastRequest.word, youglishLastRequest.language);
  }
}

// Bind close events
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("youglish-close");
  const modal = document.getElementById("youglish-modal") as HTMLDialogElement | null;
  if (closeBtn) closeBtn.addEventListener("click", closeYouGlish);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeYouGlish();
    });
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeYouGlish();
    });
    modal.addEventListener("close", () => {
      if (youglishWidget) youglishWidget.pause();
    });
  }
});
