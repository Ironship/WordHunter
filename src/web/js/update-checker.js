import { state, saveState } from "./state.js";
import { t } from "./i18n.js";

const GITHUB_RELEASES_URL = "https://github.com/Ironship/WordHunter/releases";

function parseVersion(v) {
  return (v || "").replace(/^v/, "").replace(/[-+].*$/, "").split(".").map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const an = a[i] || 0;
    const bn = b[i] || 0;
    if (an > bn) return true;
    if (an < bn) return false;
  }
  return false;
}

export async function checkForUpdates() {
  if (state.preferences.disableUpdateCheck) return;

  try {
    const res = await fetch("/__update/check");
    if (!res.ok) return;
    const data = await res.json();
    if (data.error || !data.latest) return;

    if (!isNewer(data.latest, data.current)) return;

    if (state.preferences.skippedVersion === data.latest) return;

    const dialog = document.getElementById("update-dialog");
    if (!dialog) return;

    const msgEl = document.getElementById("update-message");
    const titleEl = document.getElementById("update-title");
    if (msgEl) msgEl.textContent = t("update.message", { version: data.latest, current: data.current });
    if (titleEl) titleEl.textContent = t("update.title");

    // "Skip this version" — save and close, won't show again until next release
    const skipBtn = document.getElementById("update-skip");
    if (skipBtn) {
      const newBtn = skipBtn.cloneNode(true);
      skipBtn.replaceWith(newBtn);
      newBtn.addEventListener("click", () => {
        state.preferences.skippedVersion = data.latest;
        saveState();
        dialog.close();
      });
    }

    // "Don't remind me again" — permanently disable
    const disableBtn = document.getElementById("update-disable");
    if (disableBtn) {
      const newBtn = disableBtn.cloneNode(true);
      disableBtn.replaceWith(newBtn);
      newBtn.addEventListener("click", () => {
        state.preferences.disableUpdateCheck = true;
        saveState();
        dialog.close();
      });
    }

    // "See what's new" — open releases page in external browser
    const openBtn = document.getElementById("update-open");
    if (openBtn) {
      const newBtn = openBtn.cloneNode(true);
      openBtn.replaceWith(newBtn);
      newBtn.addEventListener("click", () => {
        window.open(GITHUB_RELEASES_URL, "_blank");
        dialog.close();
      });
    }

    dialog.showModal();
  } catch (e) {
    console.warn("Update check failed:", e);
  }
}
