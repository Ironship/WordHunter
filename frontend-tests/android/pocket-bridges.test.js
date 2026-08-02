import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function assertSourceOrder(source, before, after, message) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `Missing source marker: ${before}`);
  assert.notEqual(afterIndex, -1, `Missing source marker: ${after}`);
  assert.ok(beforeIndex < afterIndex, message || `Expected ${before} before ${after}`);
}

describe("Android Pocket bridges", () => {
  it("routes Pocket TTS through the Android native bridge", async () => {
    const listeners = {};
    const calls = [];
    let stopped = false;

    globalThis.window = {
      WordHunterAndroid: {
        speak(text, lang, rate, id) {
          calls.push({ text, lang, rate, id });
          return true;
        },
        stopTts() {
          stopped = true;
        }
      },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
      removeEventListener(type) {
        delete listeners[type];
      },
      getSelection() {
        return { isCollapsed: true };
      }
    };
    const tokenClasses = [new Set(), new Set(), new Set()];
    const scrolls = [];
    let container;
    const tokens = ["Hallo", "Welt", "Welt"].map((textContent, index) => ({
      textContent,
      dataset: {},
      classList: { add: (name) => tokenClasses[index].add(name), remove: (name) => tokenClasses[index].delete(name) },
      closest: () => container,
      getBoundingClientRect: () => ({ top: 20 + index * 120, bottom: 40 + index * 120, height: 20 })
    }));
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.document = {
      querySelectorAll(selector) {
        if (selector === ".tts-current-word") return tokens.filter((_, index) => tokenClasses[index].has("tts-current-word"));
        return [];
      }
    };

    const { state } = await import("../../dist/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "fast";
    state.preferences.ttsWordHighlight = true;

    const { speakText } = await import("../../dist/web/js/tts.js");
    let finished = false;
    container = {
      classList: { add() {} },
      querySelectorAll: () => tokens,
      contains: (token) => tokens.includes(token),
      clientHeight: 100,
      scrollHeight: 500,
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
      scrollTo(options) { scrolls.push(options); this.scrollTop = options.top; }
    };
    speakText("Hallo. Welt.", container, () => { finished = true; });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "Hallo.");
    assert.equal(calls[0].lang, "de-DE");
    assert.equal(calls[0].rate, 1.25);

    listeners["wordhunter:android-tts"]({ detail: { id: calls[0].id, status: "range", start: 0, end: 5 } });
    assert.equal(tokenClasses[0].has("tts-current-word"), true);

    listeners["wordhunter:android-tts"]({ detail: { id: calls[0].id, status: "done" } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].text, "Welt.");

    listeners["wordhunter:android-tts"]({ detail: { id: calls[1].id, status: "range", start: 0, end: 4 } });
    assert.equal(tokenClasses[0].has("tts-current-word"), false);
    assert.equal(tokenClasses[1].has("tts-current-word"), true);
    assert.deepEqual(scrolls, [{ top: 100, behavior: "auto" }]);

    listeners["wordhunter:android-tts"]({ detail: { id: calls[1].id, status: "done" } });
    assert.equal(finished, true);
    assert.equal(stopped, true);

    speakText("Welt.", container, null, { startTokenIndex: 2 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 3);
    listeners["wordhunter:android-tts"]({ detail: { id: calls[2].id, status: "range", start: 0, end: 4 } });
    assert.equal(tokenClasses[1].has("tts-current-word"), false);
    assert.equal(tokenClasses[2].has("tts-current-word"), true);
    listeners["wordhunter:android-tts"]({ detail: { id: calls[2].id, status: "done" } });
  });

  it("forwards dictionary URLs through the live Android bridge", async () => {
    const calls = [];
    globalThis.window = {
      WordHunterAndroid: {
        openUrl(url) {
          calls.push(url);
          return true;
        }
      }
    };

    const { openAndroidUrl } = await import("../../dist/web/js/platform.js");

    assert.equal(openAndroidUrl("https://dict.test/wort"), true);
    assert.deepEqual(calls, ["https://dict.test/wort"]);

    window.WordHunterAndroid.openUrl = () => false;
    assert.equal(openAndroidUrl("https://dict.test/unhandled"), false);
    delete window.WordHunterAndroid;
    assert.equal(openAndroidUrl("https://dict.test/no-bridge"), false);
  });

  it("defines the native URL and TTS callback security contracts", () => {
    const shared = readFileSync(new URL("../../dist/web/js/events/shared.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../dist/web/app.js", import.meta.url), "utf8");
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assertSourceOrder(shared, "openAndroidUrl(url)", "window.__qtBridge");
    assert.match(app, /openAndroidUrl\(link\.href\)/);
    assert.match(activity, /fun openUrl\(url: String\?\): Boolean/);
    assert.match(activity, /if \(scheme != "http" && scheme != "https"\) return false/);
    assert.match(activity, /Intent\(Intent\.ACTION_VIEW, uri\)/);
    assert.match(activity, /intent\.addCategory\(Intent\.CATEGORY_BROWSABLE\)/);
    assert.match(activity, /override fun onRangeStart\(utteranceId: String\?, start: Int, end: Int, frame: Int\)/);
    assert.match(activity, /dispatchAndroidTtsResult\(utteranceId, "range", start, end\)/);
  });

  it("keeps the Android TTS return notification private and process-scoped", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /ActivityResultContracts\.RequestPermission\(\)/);
    assert.match(activity, /Manifest\.permission\.POST_NOTIFICATIONS/);
    assert.match(activity, /NotificationManager\.IMPORTANCE_LOW/);
    assert.match(activity, /Intent\(this, MainActivity::class\.java\)/);
    assert.match(activity, /PendingIntent\.FLAG_UPDATE_CURRENT or PendingIntent\.FLAG_IMMUTABLE/);
    assert.match(activity, /setVisibility\(Notification\.VISIBILITY_PRIVATE\)/);
    assert.match(activity, /override fun onStart\(utteranceId: String\?\) \{\s*showTtsNotification\(\)/);
    assert.match(activity, /override fun onDone\(utteranceId: String\?\) \{\s*dispatchAndroidTtsResult\(utteranceId, "done"\)/);
    assert.match(activity, /fun stopTts\(\) \{[\s\S]*textToSpeech\?\.stop\(\)[\s\S]*hideTtsNotification\(\)/);
    assert.match(activity, /fun endTtsSession\(\) \{[\s\S]*hideTtsNotification\(\)[\s\S]*clearKeepScreenOn\(\)/);
    assert.match(activity, /setOngoing\(true\)/);
    assert.match(activity, /Notification\.Action\.Builder\(\s*Icon\.createWithResource\(this, android\.R\.drawable\.ic_media_pause\),\s*"Stop",\s*stopPendingIntent\s*\)\.build\(\)/);
    assert.doesNotMatch(activity, /\bMediaSession\b|startForeground\(|startForegroundService\(|class \w+ : Service/);
  });

  it("defines Android PDF rendering and overlay integration ABIs", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const importEvents = readFileSync(new URL("../../dist/web/js/events/book-import.js", import.meta.url), "utf8");

    assert.match(activity, /import android\.graphics\.pdf\.PdfRenderer/);
    assert.match(activity, /private val pdfRenderSessions = mutableMapOf<String, PdfRenderSession>\(\)/);
    assert.match(activity, /fun beginPdfRender\(sessionId: String\?, dataUrl: String\?\): String/);
    assert.match(activity, /ParcelFileDescriptor\.open\(file, ParcelFileDescriptor\.MODE_READ_ONLY\)/);
    assert.match(activity, /PdfRenderer\(descriptor\)/);
    assert.match(activity, /fun renderPdfPage\(sessionId: String\?, pageIndex: Int, renderWidth: Int\): String/);
    assert.match(activity, /page\.render\(bitmap, null, null, PdfRenderer\.Page\.RENDER_MODE_FOR_DISPLAY\)/);
    assert.match(activity, /Base64\.encodeToString\(bytes\.toByteArray\(\), Base64\.NO_WRAP\)/);
    assert.match(activity, /fun endPdfRender\(sessionId: String\?\)/);
    assert.match(activity, /closeAllPdfRenderSessions\(\)/);
    assert.match(importEvents, /getAndroidPdfRendererBridge\(\)/);
    assert.match(importEvents, /renderAndSaveAndroidPdfPages\(data, id, pages\)/);
    assert.match(importEvents, /pending_import: true/);
  });

  it("defines the Android create-document export ABI", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const syncActions = readFileSync(new URL("../../dist/web/js/sync-actions.js", import.meta.url), "utf8");

    assert.match(activity, /fun saveExport\(data: String\?, filename: String\?, mime: String\?, requestId: String\?\): Boolean/);
    assert.match(activity, /private val exportDocumentLauncher = registerForActivityResult\(/);
    assert.match(activity, /exportDocumentLauncher\.launch\(createExportDocumentIntent\(/);
    assert.match(activity, /Intent\(Intent\.ACTION_CREATE_DOCUMENT\)/);
    assert.match(activity, /Intent\.CATEGORY_OPENABLE/);
    assert.match(activity, /Intent\.EXTRA_TITLE/);
    assert.match(activity, /openFileDescriptor\(uri, "wt"\)/);
    assert.match(activity, /exportExecutor\.execute \{/);
    assert.match(activity, /OutputStreamWriter\(output, Charsets\.UTF_8\)/);
    assert.match(activity, /dispatchAndroidExportProgress\(export\.requestId, "writing"\)/);
    assert.doesNotMatch(activity, /data\.toByteArray\(Charsets\.UTF_8\)/);
    assert.match(activity, /output\.fd\.sync\(\)/);
    assert.match(syncActions, /const bridge = window\.WordHunterAndroid/);
    assert.match(syncActions, /typeof bridge\?\.saveExport !== "function"/);
    assert.match(syncActions, /wordhunter:android-export/);
    assert.match(syncActions, /detail\.requestId !== requestId/);
    assert.match(syncActions, /detail\.terminal === false/);
    assert.match(syncActions, /timeout = null/);
    assert.match(syncActions, /bridge\.saveExport\(data, filename, mime, requestId\)/);
  });
});
