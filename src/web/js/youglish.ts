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
  theme: "dark" | "light";
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

import { showToast } from "./toast.js";
import { t as rawT } from "./i18n.js";
import { resolveTheme } from "./theme.js";
import { effectiveLearningLanguage } from "./translator-preferences.js";

let youglishApiReady = false;
let youglishApiPromise: Promise<void> | null = null;
const t = rawT as (key: string, vars?: TranslationVars) => string;

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
    theme,
    events: {
      'onFetchDone': (e) => {
        if (e && e.totalResult === 0) {
          showToast(t("toast.youglishNoResults"));
        }
      },
      'onError': (_event) => {
        showToast(t("toast.youglishBlocked"));
      }
    }
  });
  youglishWidgetTheme = theme;
  return true;
}

youglishWindow.onYouglishAPIReady = () => {
  youglishApiReady = true;
};

function loadYouglishApi(): Promise<void> {
  if (youglishWindow.YG?.Widget) {
    youglishApiReady = true;
    return Promise.resolve();
  }
  if (youglishApiPromise) return youglishApiPromise;

  youglishApiPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-youglish-api="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const previousReady = youglishWindow.onYouglishAPIReady;
    youglishWindow.onYouglishAPIReady = () => {
      previousReady?.();
      youglishApiReady = true;
      resolve();
    };

    const script = document.createElement("script");
    script.async = true;
    script.charset = "utf-8";
    script.src = "https://youglish.com/public/emb/widget.js";
    script.dataset.youglishApi = "true";
    script.addEventListener("load", () => {
      if (youglishWindow.YG?.Widget) {
        youglishApiReady = true;
        resolve();
      }
    }, { once: true });
    script.addEventListener("error", reject, { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    youglishApiPromise = null;
    throw error;
  });

  return youglishApiPromise;
}

function getYouglishLang(langCode: string): string {
  const map: Record<string, string> = { en: "english", de: "german", es: "spanish", it: "italian", fr: "french", pl: "polish", ru: "russian", uk: "ukrainian", ja: "japanese", zh: "chinese", la: "latin", grc: "greek" };
  return map[langCode] || "english";
}

async function fetchYouGlish(word: string): Promise<void> {
  try {
    await loadYouglishApi();
  } catch (error) {
    showToast(t("toast.youglishBlocked"));
    return;
  }
  if (youglishWindow.YG?.Widget) {
    youglishApiReady = true;
    initYouglish();
  }
  const ygLang = getYouglishLang(effectiveLearningLanguage(state.preferences));
  if (youglishWidget) {
    youglishLastRequest = { word, language: ygLang };
    youglishWidget.fetch(word, ygLang);
  }
}

export function openYouGlish(word: string): void {
  const modal = document.getElementById("youglish-modal") as HTMLDialogElement | null;
  const modalBody = document.getElementById("youglish-modal-body");

  if (modalBody) {
    if (document.getElementById("youglish-widget")?.parentNode !== modalBody) {
      modalBody.innerHTML = '<div id="youglish-widget"></div>';
      youglishWidget = null;
      youglishWidgetTheme = null;
      if (youglishApiReady) {
        initYouglish();
      }
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
