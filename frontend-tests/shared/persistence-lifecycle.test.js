import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

describe("persistence lifecycle", () => {
  it("flushes pending saves when the window or mobile WebView is backgrounded", () => {
    const app = readFileSync(new URL("../../src/web/app.js", import.meta.url), "utf8");

    assert.match(app, /function flushPendingStateBeforeExit\(\)/);
    assert.match(app, /addEventListener\("beforeunload", flushPendingStateBeforeExit\)/);
    assert.match(app, /addEventListener\("pagehide", flushPendingStateBeforeExit\)/);
    assert.match(app, /visibilityState === "hidden"/);
    assert.match(app, /if \(isAndroidPlatform\(\)\) \{\s*saveState\(\);\s*return;\s*\}/);
  });

  it("backs off bridge save retries after repeated filesystem failures", () => {
    const autosave = readFileSync(new URL("../../src/web/js/state/autosave.js", import.meta.url), "utf8");

    assert.match(autosave, /let retryDelayMs = 0/);
    assert.match(autosave, /Math\.min\(retryDelayMs \* 2, 30000\)/);
    assert.match(autosave, /scheduleSave\(retryDelayMs\)/);
  });

  it("surfaces sync save state in settings and toast messages", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const dom = readFileSync(new URL("../../src/web/js/dom.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/web/app.js", import.meta.url), "utf8");
    const autosave = readFileSync(new URL("../../src/web/js/state/autosave.js", import.meta.url), "utf8");
    const api = readFileSync(new URL("../../src/web/js/api.js", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");

    assert.match(html, /id="sync-status"/);
    assert.match(html, /id="sync-directory"/);
    assert.match(html, /id="choose-sync-directory"/);
    assert.match(html, /id="force-sync"/);
    assert.match(html, /id="sync-conflicts-panel"/);
    assert.match(html, /id="sync-conflicts-list"/);
    assert.match(html, /id="recovery-status-panel"/);
    assert.match(html, /id="recovery-status-list"/);
    assert.match(html, /data-i18n="settings\.dataFolderCloudDelay"/);
    assert.match(dom, /syncStatus = document\.getElementById\("sync-status"\)/);
    assert.match(dom, /syncDirectory = document\.getElementById\("sync-directory"\)/);
    assert.match(dom, /chooseSyncDirectory = document\.getElementById\("choose-sync-directory"\)/);
    assert.match(dom, /forceSync = document\.getElementById\("force-sync"\)/);
    assert.match(dom, /syncConflictsPanel = document\.getElementById\("sync-conflicts-panel"\)/);
    assert.match(dom, /syncConflictsList = document\.getElementById\("sync-conflicts-list"\)/);
    assert.match(dom, /recoveryStatusPanel = document\.getElementById\("recovery-status-panel"\)/);
    assert.match(dom, /recoveryStatusList = document\.getElementById\("recovery-status-list"\)/);
    assert.match(preferences, /export function setSyncStatus/);
    assert.match(preferences, /data-conflict-resolution="keep-current"/);
    assert.match(preferences, /data-conflict-resolution="use-conflict"/);
    assert.match(preferences, /function renderRecoveryStatus/);
    assert.match(settings, /forceSync[\s\S]*await saveState\(\)/);
    assert.match(settings, /async function reloadActiveDataFolder/);
    assert.match(settings, /fetch\("\/__store\/load", \{ cache: "no-store" \}\)/);
    assert.match(settings, /async function syncNow/);
    assert.match(settings, /fetch\("\/__store\/sync_now"/);
    assert.match(settings, /async function resolveSyncConflict/);
    assert.match(settings, /fetch\("\/__store\/resolve_conflict"/);
    assert.match(router, /"\/__store\/recovery_status"/);
    assert.match(settings, /WordHunterAndroid\.chooseSyncFolder\(window\.WH_TOKEN \|\| ""\)/);
    assert.match(settings, /WordHunterAndroid\.forceSyncFolder\(window\.WH_TOKEN \|\| ""\)/);
    assert.match(settings, /forceSync[\s\S]*await syncNow\(\)/);
    assert.match(settings, /syncNow\(\{ background: true, saveFirst: false \}\)/);
    assert.match(settings, /window\.addEventListener\("wordhunter:sync-saved", \(\) => scheduleBackgroundSync\(1500\)\)/);
    assert.match(settings, /scheduleBackgroundSync\(0\)/);
    assert.match(settings, /document\.addEventListener\("visibilitychange"[\s\S]*scheduleBackgroundSync\(0\)/);
    assert.match(app, /wordhunter:sync-error/);
    assert.match(app, /toast\.syncUnavailable/);
    assert.doesNotMatch(app, /Data changed in the synced folder/);
    assert.doesNotMatch(app, /Could not save changes\. Check sync folder access/);
    assert.match(autosave, /wordhunter:sync-saved/);
    assert.match(autosave, /wordhunter:sync-error/);
    assert.match(api, /wordhunter:sync-error/);
  });

  it("keeps startup visually stable without a permanent blank screen", () => {
    const html = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/web/app.js", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const state = readFileSync(new URL("../../src/web/js/state.js", import.meta.url), "utf8");

    assert.match(html, /class="app-booting"/);
    assert.match(html, /<meta name="theme-color" content="#0d1114">/);
    assert.match(html, /html\.app-booting,html\.app-booting body\{background:#0d1114;color-scheme:dark\}/);
    assert.match(styles, /html\.app-booting \.app-shell[\s\S]*visibility: hidden/);
    assert.match(styles, /html\.app-booting body::before[\s\S]*background: #0d1114/);
    assert.match(styles, /html\.app-booting body::after[\s\S]*background: url\("favicon\.svg"\)[\s\S]*animation: boot-logo-pulse 1\.15s ease-in-out infinite !important/);
    assert.doesNotMatch(styles, /content: "Word Hunter"/);
    assert.match(app, /finally \{[\s\S]*classList\.remove\("app-booting"\)/);
    assert.match(app, /async function loadBridgeStateBeforeRender/);
    assert.match(app, /fetch\("\/__store\/load", \{ cache: "no-store" \}\)/);
    assert.match(app, /replaceState\(loadState\(\), \{ save: false \}\)/);
    assert.match(state, /export function replaceState\(nextState, \{ save = true \} = \{\}\)/);
    assert.doesNotMatch(handlers, /xhr\.open\('GET', '\/__store\/load', false\)/);
  });

  it("requires a backup before destructive clearing actions", () => {
    const actions = readFileSync(new URL("../../src/web/js/sync-actions.js", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");

    assert.match(actions, /LAST_BACKUP_KEY/);
    assert.match(actions, /async function backupBeforeClear\(\)/);
    assert.match(actions, /export async function clearWords\(\)[\s\S]*if \(!await backupBeforeClear\(\)\) return/);
    assert.match(actions, /export async function clearLibrary\(\)[\s\S]*if \(!await backupBeforeClear\(\)\) return/);
    assert.match(actions, /export async function clearLocalState\(\)[\s\S]*if \(!await backupBeforeClear\(\)\) return/);
    assert.match(handlers, /pub\(crate\) fn save_export\(payload: Value\) -> Result<bool, String>/);
    assert.match(router, /json!\(\{ "saved": saved \}\)/);
  });

  it("ships sync safety copy in every locale", () => {
    const localeDir = new URL("../../src/web/i18n/", import.meta.url);
    const required = [
      ["settings", "syncStatusDefault"],
      ["settings", "syncStatusReady"],
      ["settings", "syncStatusSaved"],
      ["settings", "syncStatusError"],
      ["settings", "syncConflictCount"],
      ["settings", "syncConflictDevice"],
      ["settings", "syncConflictDeleted"],
      ["settings", "syncConflictUpdated"],
      ["settings", "syncConflictRefresh"],
      ["settings", "syncConflictUnknown"],
      ["settings", "syncConflictMeta"],
      ["settings", "syncConflictKeepCurrent"],
      ["settings", "syncConflictUseOther"],
      ["settings", "syncConflictResolved"],
      ["settings", "recoveryStatusTitle"],
      ["settings", "recoveryPendingSave"],
      ["settings", "recoveryPendingSaveTemp"],
      ["settings", "recoveryPendingWipe"],
      ["settings", "recoveryQuarantinedJournal"],
      ["settings", "recoverySkippedRecords"],
      ["settings", "recoveryCorruptConflicts"],
      ["settings", "migrationComplete"],
      ["settings", "syncFolderDefault"],
      ["settings", "syncFolderPath"],
      ["settings", "chooseSyncFolder"],
      ["settings", "syncFolderChanged"],
      ["settings", "syncFolderMissing"],
      ["settings", "androidDataFolderFixed"],
      ["settings", "dataFolderCloudDelay"],
      ["settings", "forceSync"],
      ["toast", "backupCreated"],
      ["toast", "backupRequired"],
      ["toast", "exportCancelled"],
      ["toast", "syncUnavailable"]
    ];

    for (const file of readdirSync(localeDir).filter((name) => name.endsWith(".json"))) {
      const locale = JSON.parse(readFileSync(new URL(file, localeDir), "utf8"));
      for (const [section, key] of required) {
        assert.equal(typeof locale[section]?.[key], "string", `${file} missing ${section}.${key}`);
      }
    }
  });
});
