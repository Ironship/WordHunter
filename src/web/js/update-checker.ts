import { state, saveState } from "./state.js";
import { openAndroidUrl } from "./platform.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

const GITHUB_RELEASES_URL = "https://github.com/Ironship/WordHunter/releases";

interface UpdateCheckOptions {
  manual?: boolean;
}

interface ParsedVersion {
  core: number[];
  prerelease: string[] | null;
}

function parseVersion(v: unknown): ParsedVersion {
  const normalized = String(v || "").trim().replace(/^[vV]/, "").split("+", 1)[0];
  const separator = normalized.indexOf("-");
  const core = (separator >= 0 ? normalized.slice(0, separator) : normalized)
    .split(".")
    .map(part => /^\d+$/.test(part) ? Number(part) : 0);
  const prerelease = separator >= 0
    ? normalized.slice(separator + 1).split(".").filter(Boolean)
    : null;
  return { core, prerelease };
}

function comparePrerelease(latest: string[], current: string[]): number {
  for (let index = 0; index < Math.max(latest.length, current.length); index += 1) {
    if (index >= latest.length) return -1;
    if (index >= current.length) return 1;
    const leftNumeric = /^\d+$/.test(latest[index]);
    const rightNumeric = /^\d+$/.test(current[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(latest[index]) - Number(current[index]);
      if (difference) return difference;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const ordering = latest[index].localeCompare(current[index]);
      if (ordering) return ordering;
    }
  }
  return 0;
}

export function isNewer(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const an = a.core[i] || 0;
    const bn = b.core[i] || 0;
    if (an > bn) return true;
    if (an < bn) return false;
  }
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  if (a.prerelease && b.prerelease) return comparePrerelease(a.prerelease, b.prerelease) > 0;
  return false;
}

export async function checkForUpdates({ manual = false }: UpdateCheckOptions = {}): Promise<void> {
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
    if (!(dialog instanceof HTMLDialogElement)) return;

    const msgEl = document.getElementById("update-message");
    const titleEl = document.getElementById("update-title");
    if (msgEl) msgEl.textContent = t("update.message", { version: data.latest, current: data.current });
    if (titleEl) titleEl.textContent = t("update.title");

    const dismissBtn = document.getElementById("update-dismiss");
    if (dismissBtn instanceof HTMLButtonElement) {
      const newBtn = dismissBtn.cloneNode(true);
      if (newBtn instanceof HTMLButtonElement) {
        dismissBtn.replaceWith(newBtn);
        newBtn.addEventListener("click", () => dialog.close());
      }
    }

    // "Skip this version" — save and close, won't show again until next release
    const skipBtn = document.getElementById("update-skip");
    if (skipBtn instanceof HTMLButtonElement) {
      const newBtn = skipBtn.cloneNode(true);
      if (newBtn instanceof HTMLButtonElement) {
        skipBtn.replaceWith(newBtn);
        newBtn.addEventListener("click", () => {
          state.preferences.skippedVersion = data.latest;
          saveState();
          dialog.close();
        });
      }
    }

    // "Don't remind me again" — permanently disable
    const disableBtn = document.getElementById("update-disable");
    if (disableBtn instanceof HTMLButtonElement) {
      const newBtn = disableBtn.cloneNode(true);
      if (newBtn instanceof HTMLButtonElement) {
        disableBtn.replaceWith(newBtn);
        newBtn.addEventListener("click", () => {
          state.preferences.disableUpdateCheck = true;
          saveState();
          dialog.close();
        });
      }
    }

    // "See what's new" — open releases page in external browser
    const openBtn = document.getElementById("update-open");
    if (openBtn instanceof HTMLButtonElement) {
      const newBtn = openBtn.cloneNode(true);
      if (newBtn instanceof HTMLButtonElement) {
        openBtn.replaceWith(newBtn);
        newBtn.addEventListener("click", () => {
          if (!openAndroidUrl(GITHUB_RELEASES_URL)) {
            window.open(GITHUB_RELEASES_URL, "_blank");
          }
          dialog.close();
        });
      }
    }

    dialog.showModal();
  } catch (e) {
    console.warn("Update check failed:", e);
    if (manual) showToast(t("update.checkFailed"));
  }
}

/**
 * Builds the update dialog markup once (idempotent). Called during app
 * boot before cacheElements() so every consumer finds the elements in the
 * DOM; data-i18n attributes are applied by the boot-time applyTranslations()
 * pass (see app.ts).
 */
export function renderUpdateDialog(): HTMLDialogElement {
  const existing = document.getElementById("update-dialog");
  if (existing instanceof HTMLDialogElement) return existing;
  if (existing) throw new TypeError("#update-dialog must be a dialog element");

  const dialog = document.createElement("dialog");
  dialog.id = "update-dialog";
  dialog.className = "panel dialog-500";
  dialog.setAttribute("aria-labelledby", "update-title");
  dialog.innerHTML = `
    <div class="panel-header">
      <h2 class="row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-20-green"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
        <span id="update-title" data-i18n="update.title">Update Available</span>
      </h2>
    </div>
    <div class="settings-body p-15-g-1">
      <p id="update-message" data-i18n="update.message" class="m-0-fs-09-lh-15-muted">Word Hunter {version} is available! (You have {current})</p>
      <div class="justify-end-wrap-m-t-1">
        <button id="update-dismiss" class="ghost-button" data-i18n="update.dismiss">Later</button>
        <button id="update-skip" class="secondary-button" data-i18n="update.skipLabel">Skip this version</button>
        <button id="update-disable" class="secondary-button" data-i18n="update.disableUpdates">Don't remind me again</button>
        <button id="update-open" class="primary-button" data-i18n="update.openReleases">See what's new</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}
