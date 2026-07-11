import { state } from "./state.js";
let youglishWidget = null;

import { showToast } from "./toast.js";
import { t } from "./i18n.js";
import { resolveTheme } from "./theme.js";

let youglishApiReady = false;
let youglishApiPromise = null;

function initYouglish() {
  if (youglishWidget) return;
  const isDark = resolveTheme(state.preferences.theme, window.matchMedia?.('(prefers-color-scheme: dark)').matches).mode === "dark";
  const w = Math.min(640, window.innerWidth - 64);
  youglishWidget = new YG.Widget("youglish-widget", {
    width: w,
    components: 9,
    theme: isDark ? "dark" : "light",
    events: {
      'onFetchDone': (e) => {
        if (e && e.totalResult === 0) {
          showToast(t("toast.youglishNoResults"));
        }
      },
      'onError': (e) => {
        showToast(t("toast.youglishBlocked"));
      }
    }
  });
}

window.onYouglishAPIReady = () => {
  youglishApiReady = true;
};

function loadYouglishApi() {
  if (typeof YG !== "undefined" && YG.Widget) {
    youglishApiReady = true;
    return Promise.resolve();
  }
  if (youglishApiPromise) return youglishApiPromise;

  youglishApiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-youglish-api="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const previousReady = window.onYouglishAPIReady;
    window.onYouglishAPIReady = () => {
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
      if (typeof YG !== "undefined" && YG.Widget) {
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

function getYouglishLang(langCode) {
  const map = { en: "english", de: "german", es: "spanish", it: "italian", fr: "french", pl: "polish", ru: "russian", uk: "ukrainian", ja: "japanese", zh: "chinese", la: "latin", grc: "greek" };
  return map[langCode] || "english";
}

async function fetchYouGlish(word) {
  try {
    await loadYouglishApi();
  } catch (error) {
    showToast(t("toast.youglishBlocked"));
    return;
  }
  if (!youglishWidget && typeof YG !== "undefined" && YG.Widget) {
    youglishApiReady = true;
    initYouglish();
  }
  const ygLang = getYouglishLang(state.preferences.learningLanguage || "en");
  if (youglishWidget) {
    youglishWidget.fetch(word, ygLang);
  }
}

export function openYouGlish(word) {
  const modal = document.getElementById("youglish-modal");
  const modalBody = document.getElementById("youglish-modal-body");

  if (modalBody) {
    if (document.getElementById("youglish-widget")?.parentNode !== modalBody) {
      modalBody.innerHTML = '<div id="youglish-widget"></div>';
      youglishWidget = null;
      if (youglishApiReady) {
        initYouglish();
      }
    }
  }

  if (modal && typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  }
  fetchYouGlish(word);
}

export function closeYouGlish() {
  const modal = document.getElementById("youglish-modal");
  if (modal && typeof modal.close === "function") modal.close();
  if (youglishWidget) {
    youglishWidget.pause();
  }
}

// Bind close events
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("youglish-close");
  const modal = document.getElementById("youglish-modal");
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
