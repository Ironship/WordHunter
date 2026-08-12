import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ACTIVITY_URL = new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url);

describe("Android runtime lifecycle contracts", () => {
  it("keeps the SAF export timeout out of the picker-foreground window", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // A user may spend minutes inside the system save dialog; a timeout
    // armed before the picker launch would fire while the dialog is still
    // foreground and silently drop the destination the user just chose.
    // The timeout must instead be cancelled in onPause and re-armed as a
    // short grace period in onResume while the export still awaits a pick.
    assert.doesNotMatch(activity, /mainHandler\.postDelayed\([^)]*ANDROID_EXPORT_TIMEOUT_MS/);
    assert.match(activity, /private const val ANDROID_EXPORT_GRACE_MS = \d[\d_]*L/);
    assert.match(activity, /override fun onPause\(\) \{[\s\S]{0,400}removeCallbacks\(it\)/);
    assert.match(activity, /override fun onResume\(\) \{[\s\S]{0,1200}ANDROID_EXPORT_GRACE_MS/);
  });

  it("watchdogs and supersedes a stale Android import picker", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // An abandoned picker must not block every later import until the
    // process dies: the pending request gets a native watchdog and a fresh
    // import supersedes (cancels) the stale one instead of being rejected.
    assert.match(activity, /private const val ANDROID_IMPORT_TIMEOUT_MS = 5 \* 60 \* 1000L/);
    assert.match(activity, /fun chooseImportPackage\(requestId: String\?\): Boolean[\s\S]{0,1600}ANDROID_IMPORT_TIMEOUT_MS/);
    assert.match(activity, /"Android import superseded\."/);
    assert.match(activity, /"Android import timed out\."/);
  });

  it("drains the export executor on destroy instead of interrupting writes", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // shutdownNow() interrupts a mid-write export and leaves a partial file
    // in the user's destination; the executor must drain with a short join.
    assert.doesNotMatch(activity, /shutdownNow\(\)/);
    assert.match(activity, /exportExecutor\.shutdown\(\)/);
    assert.match(activity, /awaitTermination\(/);
  });

  it("guards every WebView dispatch with the destroyed check", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // Bridge dispatchers must not post onto a destroyed WebView; every
    // dispatch goes through a single guarded helper with a local capture.
    assert.doesNotMatch(activity, /appWebView\?\.post/);
    assert.match(activity, /private fun postToWebView\([\s\S]{0,300}isDestroyed \|\| isFinishing[\s\S]{0,300}webView\.post/);
  });

  it("reads the PDF page count under the render lock", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    assert.doesNotMatch(activity, /put\("pageCount", pdfRenderSessions\[id\]/);
    assert.match(activity, /val pageCount = synchronized\(pdfRenderLock\)/);
  });

  it("serializes PDF page rendering against session teardown", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // closeAllPdfRenderSessions() on destroy must never close a PdfRenderer
    // while a page is mid-render on the bridge thread.
    assert.match(activity, /synchronized\(pdfRenderLock\) \{\s*renderPdfPageLocked\(/);
    assert.match(activity, /private fun renderPdfPageLocked\(/);
  });

  it("drops the double-delivery re-post for terminal export results", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    assert.doesNotMatch(activity, /postDelayed\([\s\S]{0,250}250\)/);
  });

  it("clears the TTS notification and keep-screen-on when the queue drains", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // A finished single-word utterance must release the notification and
    // FLAG_KEEP_SCREEN_ON once nothing is speaking anymore.
    assert.match(activity, /fun maybeClearTtsSessionUi\(\)[\s\S]{0,300}isSpeaking == false[\s\S]{0,200}hideTtsNotification\(\)[\s\S]{0,100}clearKeepScreenOn\(\)/);
    assert.match(activity, /override fun onDone\(utteranceId: String\?\) \{\s*dispatchAndroidTtsResult\(utteranceId, "done"\)\s*maybeClearTtsSessionUi\(\)/);
    assert.match(activity, /override fun onError\(utteranceId: String\?\) \{\s*dispatchAndroidTtsResult\(utteranceId, "error"\)\s*maybeClearTtsSessionUi\(\)/);
    assert.match(activity, /override fun onStop\(utteranceId: String\?, interrupted: Boolean\) \{\s*dispatchAndroidTtsResult\(utteranceId, "stopped"\)\s*maybeClearTtsSessionUi\(\)/);
  });

  it("wires an onEnd into the single-word Android speak path", () => {
    const ttsJs = readFileSync(new URL("../../dist/web/js/tts.js", import.meta.url), "utf8");

    assert.match(ttsJs, /speakSentenceAndroid\(word,[\s\S]{0,120}endAndroidTtsSession\(\)/);
  });

  it("generates distinct day/night Android themes with matching status-bar icon direction", () => {
    const buildBat = readFileSync(new URL("../../scripts/build.bat", import.meta.url), "utf8");

    // The Android res/ tree is generated by Prepare-AndroidProject and used
    // to be byte-identical across values/ and values-night/ with
    // windowLightStatusBar=false in both. Night (dark background) needs
    // light icons (windowLightStatusBar=false); day (light background)
    // needs dark icons (windowLightStatusBar=true).
    assert.match(buildBat, /Set-Content -LiteralPath \(Join-Path \$valuesDir "themes\.xml"\) -Value \$dayThemeXml/);
    assert.match(buildBat, /Set-Content -LiteralPath \(Join-Path \$nightValuesDir "themes\.xml"\) -Value \$nightThemeXml/);
    assert.match(buildBat, /\$dayThemeXml = @"[\s\S]{0,600}windowBackground">#f7f9f6[\s\S]{0,300}windowLightStatusBar">true</);
    assert.match(buildBat, /\$nightThemeXml = @"[\s\S]{0,600}windowBackground">#0d1114[\s\S]{0,300}windowLightStatusBar">false</);
  });

  it("rejects a busy Android export synchronously instead of queueing an error event", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // queueExport must return false while another export is pending so the
    // JS fast-path in waitForAndroidExport() resolves immediately instead of
    // waiting for a terminal event that never resolves the busy case.
    assert.doesNotMatch(activity, /"Android export is already running\."/);
    assert.match(activity, /if \(pendingExport != null\) \{[\s\S]{0,300}return false\s*\}/);
  });

  it("rejects oversized Android exports before the destination picker opens", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // The 64 MiB direct-write cap must be enforced in queueExport before the
    // SAF picker launches, not after the user already chose a destination.
    assert.match(activity, /private const val ANDROID_DIRECT_EXPORT_MAX_CHARS = 64L \* 1024L \* 1024L/);
    assert.match(activity, /"Export is too large for direct Android write\."/);
    const checkIndex = activity.indexOf("data.length > ANDROID_DIRECT_EXPORT_MAX_CHARS");
    const launchIndex = activity.indexOf("exportDocumentLauncher.launch(");
    assert.notEqual(checkIndex, -1, "missing size pre-check in queueExport");
    assert.ok(checkIndex < launchIndex, "size pre-check must run before the picker launch");
  });

  it("gives slow Android devices 30 s to finish booting", () => {
    const boot = readFileSync(new URL("../../src/web/boot.ts", import.meta.url), "utf8");

    assert.match(boot, /const BOOT_WATCHDOG_MS = 30_000/);
    assert.match(boot, /window\.setTimeout\(\(\) => \{\s*reportBootError\(/);
    assert.match(boot, /BOOT_WATCHDOG_MS\);/);
  });

  it("records the incoming intent in onNewIntent so TTS-stop survives recreation", () => {
    const activity = readFileSync(ACTIVITY_URL, "utf8");

    // The TTS-stop notification targets a singleTask activity; onNewIntent
    // must persist the intent with setIntent() so a later recreation (cold
    // start after the process was trimmed) still sees the stop request.
    assert.match(activity, /override fun onNewIntent\(intent: Intent\) \{\s*super\.onNewIntent\(intent\)[\s\S]{0,300}setIntent\(intent\)/);
  });
});
