import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
    const tokenClasses = [new Set(), new Set()];
    const tokens = [
      { textContent: "Hallo", dataset: {}, classList: { add: (name) => tokenClasses[0].add(name), remove: (name) => tokenClasses[0].delete(name) } },
      { textContent: "Welt", dataset: {}, classList: { add: (name) => tokenClasses[1].add(name), remove: (name) => tokenClasses[1].delete(name) } }
    ];
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.document = {
      querySelectorAll(selector) {
        if (selector === ".tts-current-word") return tokens.filter((_, index) => tokenClasses[index].has("tts-current-word"));
        return [];
      }
    };

    const { state } = await import("../../src/web/js/state.js");
    state.preferences.learningLanguage = "de";
    state.preferences.ttsRate = "fast";
    state.preferences.ttsWordHighlight = true;

    const { speakText } = await import("../../src/web/js/tts.js");
    let finished = false;
    const container = { classList: { add() {} }, querySelectorAll: () => tokens };
    speakText("Hallo. Welt.", container, () => { finished = true; });

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

    listeners["wordhunter:android-tts"]({ detail: { id: calls[1].id, status: "done" } });
    assert.equal(finished, true);
    assert.equal(stopped, true);
  });

  it("routes Pocket dictionary URLs through the Android native bridge", async () => {
    const calls = [];
    globalThis.window = {
      WordHunterAndroid: {
        openUrl(url) {
          calls.push(url);
          return true;
        }
      }
    };

    const { openAndroidUrl } = await import("../../src/web/js/platform.js");

    assert.equal(openAndroidUrl("https://dict.test/wort"), true);
    assert.deepEqual(calls, ["https://dict.test/wort"]);

    const shared = readFileSync(new URL("../../src/web/js/events/shared.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/web/app.js", import.meta.url), "utf8");
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.ok(shared.indexOf("openAndroidUrl(url)") < shared.indexOf("window.__qtBridge"));
    assert.match(app, /openAndroidUrl\(link\.href\)/);
    assert.match(activity, /fun openUrl\(url: String\?\): Boolean/);
    assert.match(activity, /Intent\(Intent\.ACTION_VIEW, uri\)/);
    assert.match(activity, /override fun onRangeStart\(utteranceId: String\?, start: Int, end: Int, frame: Int\)/);
    assert.match(activity, /dispatchAndroidTtsResult\(utteranceId, "range", start, end\)/);
  });

  it("exposes Android PDF page rendering for imported overlays", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const generatedActivityUrl = new URL("../../src-tauri/gen/android/app/src/main/java/com/wordhunter/pocket/MainActivity.kt", import.meta.url);
    const generatedActivity = existsSync(generatedActivityUrl)
      ? readFileSync(generatedActivityUrl, "utf8")
      : activity;
    const importEvents = readFileSync(new URL("../../src/web/js/events/book-import.js", import.meta.url), "utf8");

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
    assert.match(generatedActivity, /fun beginPdfRender\(sessionId: String\?, dataUrl: String\?\): String/);
    assert.match(generatedActivity, /fun renderPdfPage\(sessionId: String\?, pageIndex: Int, renderWidth: Int\): String/);
    assert.match(importEvents, /getAndroidPdfRendererBridge\(\)/);
    assert.match(importEvents, /renderAndSaveAndroidPdfPages\(data, id, pages\)/);
  });

  it("syncs a selected folder through staging without treating legacy files as canonical", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");

    assert.match(activity, /Executors\.newSingleThreadExecutor\(\)/);
    assert.match(activity, /@Volatile private var pendingSyncToken: String\? = null/);
    assert.match(activity, /ActivityResultContracts\.StartActivityForResult\(\)/);
    assert.match(activity, /Intent\(Intent\.ACTION_OPEN_DOCUMENT_TREE\)/);
    assert.match(activity, /syncFolderLauncher\.launch\(syncFolderPickerIntent\(\)\)/);
    assert.match(activity, /DocumentsContract\.EXTRA_INITIAL_URI/);
    assert.match(activity, /defaultSyncTreeUri\(\)/);
    assert.match(activity, /FLAG_GRANT_PREFIX_URI_PERMISSION/);
    assert.match(activity, /android\.content\.extra\.SHOW_ADVANCED/);
    assert.match(activity, /android\.provider\.extra\.SHOW_ADVANCED/);
    assert.doesNotMatch(activity, /ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION/);
    assert.doesNotMatch(activity, /MANAGE_EXTERNAL_STORAGE/);
    assert.match(activity, /syncExecutor\.execute \{[\s\S]*syncSelectedFolder\(uri, token = syncToken\)/);
    assert.match(activity, /fun chooseSyncFolder\(token: String\?\)/);
    assert.match(activity, /pendingSyncToken = token/);
    assert.match(activity, /fun forceSyncFolder\(token: String\?\): Boolean/);
    assert.match(activity, /syncSelectedFolder\(uri, persistPermission = false, token = token\)/);
    assert.match(activity, /fun getSyncFolderLabel\(\): String\?/);
    assert.match(activity, /getSharedPreferences\("wordhunter-sync", MODE_PRIVATE\)/);
    assert.match(activity, /folder\.name\?\.takeIf \{ it\.isNotBlank\(\) \} \?: uri\.toString\(\)/);
    assert.match(activity, /\.putString\("sync_label", label\)/);
    assert.match(activity, /val stagingRoot = prepareSyncStagingRoot\(\)/);
    assert.match(activity, /val incomingDir = File\(stagingRoot, "incoming"\)/);
    assert.match(activity, /copyDocumentTreeToFile\(folder, incomingDir, root = true\)/);
    assert.match(activity, /syncStagedDirectoryWithRust\(token\)/);
    assert.match(activity, /URL\("http:\/\/127\.0\.0\.1:38619\/__store\/sync_android_staging"\)/);
    assert.match(activity, /connection\.setRequestProperty\("X-WH-Token", syncToken\)/);
    assert.match(activity, /copyFileTreeToDocument\(incomingDir, folder, root = true\)/);
    assert.ok(router.indexOf("if !response::valid_token") < router.indexOf("\"/__store/sync_android_staging\""));
    assert.match(router, /"\/__store\/sync_android_staging"[\s\S]*handlers::sync_android_staging\(&state\)/);
    assert.match(handlers, /fn sync_android_staging\(state: &ServerState\) -> Result<Value, String>/);
    assert.match(handlers, /app_cache_dir\(\)/);
    assert.match(handlers, /join\("wordhunter-sync-staging"\)/);
    assert.match(handlers, /join\("incoming"\)/);
    assert.match(handlers, /state\.store\.sync_with_directory\(incoming_dir\)/);
    assert.match(activity, /finally \{[\s\S]*cleanupSyncStaging\(stagingRoot\)/);
    assert.match(activity, /private val knownDataNames = setOf\("records", "books", "argos-packages"\)/);
    assert.match(activity, /private val skippedBookRecordNames = setOf\("book\.json", "book\.bak", "metadata\.json", "text\.txt"\)/);
    assert.match(activity, /private fun shouldSyncRelativePath\(relativePath: String, isDirectory: Boolean\): Boolean/);
    assert.match(activity, /rootName !in knownDataNames/);
    assert.match(activity, /rootName == "books" && name in skippedBookRecordNames/);
    assert.match(activity, /relativePath == "records\/v1" \|\| relativePath\.startsWith\("records\/v1\/"\)/);
    assert.match(activity, /inRecordsV1 && isSyncRecordName\(name\)/);
    assert.match(activity, /private fun isSyncRecordName\(name: String\): Boolean/);
    assert.match(activity, /name\.endsWith\("\.json", ignoreCase = true\)[\s\S]*name\.endsWith\("\.bak", ignoreCase = true\)/);
    assert.doesNotMatch(activity, /private fun isIncompleteDocumentRecord/);
    assert.doesNotMatch(activity, /applyStagedSyncToLive/);
    assert.doesNotMatch(activity, /private fun shouldCopyLocalFile/);
    assert.doesNotMatch(activity, /private fun copyFileTreeToFile/);
    assert.doesNotMatch(activity, /private fun copyLocalFileAtomically/);
    assert.doesNotMatch(activity, /private fun syncRecordClock/);
    assert.match(preferences, /getAndroidSyncFolderLabel\(\)/);
    assert.match(preferences, /state\.syncDirectory \|\| getAndroidSyncFolderLabel\(\)/);
    assert.doesNotMatch(activity, /copyDocumentTreeToFile\(folder, appDir, root = true\)/);
    assert.doesNotMatch(activity, /copyFileTreeToDocument\(appDir, folder, root = true\)/);
    assert.doesNotMatch(activity, /"store\.sqlite"/);
    assert.doesNotMatch(activity, /"vocab\.json"/);
    assert.doesNotMatch(activity, /"save-journal\.json"/);
    assert.doesNotMatch(activity, /"device-id\.txt"/);
    assert.doesNotMatch(activity, /importDocumentTreeToAppData\(folder, appDir\)/);
    assert.doesNotMatch(activity, /WordHunter\.importing/);
    assert.doesNotMatch(activity, /clearWordHunterDir\(appDir\)[\s\S]*copyDocumentTreeToFile\(folder, appDir\)/);
  });

  it("exports Pocket files through a temporary document before replacing cloud files", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /private fun copyFileToDocument\(source: File, target: DocumentFile\)/);
    assert.match(activity, /val tempName = "\$\{source\.name\}\.tmp"/);
    assert.match(activity, /copyFileToDocument\(child, target\)/);
    assert.match(activity, /copyFileTreeToDocument\(incomingDir, folder, root = true\)/);
    assert.match(activity, /shouldSyncRelativePath\(childRelativePath, child\.isDirectory\)/);
    assert.match(activity, /val expectedLength = source\.length\(\)/);
    assert.ok(activity.indexOf("target.createFile(mimeFor(source.name), tempName)") < activity.indexOf("replaceDocumentWithTemp(temp, existing, source.name)"));
    assert.match(activity, /private fun replaceDocumentWithTemp\(temp: DocumentFile, existing: DocumentFile\?, finalName: String\)/);
    assert.match(activity, /existing\.renameTo\(backupName\)/);
    assert.match(activity, /temp\.renameTo\(finalName\)/);
  });
});
