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
});
