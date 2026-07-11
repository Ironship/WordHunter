import { state, saveState } from "./state.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

const GITHUB_RELEASES_URL = "https://github.com/Ironship/WordHunter/releases";

function parseVersion(v) {
  return (String(v || "").match(/\d+/g) || []).map(n => parseInt(n, 10) || 0);
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

export async function checkForUpdates({ manual = false } = {}) {
  if (!manual && state.preferences.disableUpdateCheck) return;

  try {
    const res = await fetch("/__update/check");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error || !data.latest) throw new Error(data.error || "missing release version");

    if (!isNewer(data.latest, data.current)) {
      if (manual) showToast(t("update.upToDate", { current: data.current }));
      return;
    }

    if (!manual && state.preferences.skippedVersion === data.latest) return;

    const dialog = document.getElementById("update-dialog");
    if (!dialog) return;

    const msgEl = document.getElementById("update-message");
    const titleEl = document.getElementById("update-title");
    if (msgEl) msgEl.textContent = t("update.message", { version: data.latest, current: data.current });
    if (titleEl) titleEl.textContent = t("update.title");

    const dismissBtn = document.getElementById("update-dismiss");
    if (dismissBtn) {
      const newBtn = dismissBtn.cloneNode(true);
      dismissBtn.replaceWith(newBtn);
      newBtn.addEventListener("click", () => dialog.close());
    }

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
    if (manual) showToast(t("update.checkFailed"));
  }
}
