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

function sourceBetween(source, startMarker, endMarker) {
  const normalized = source.replaceAll("\r\n", "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  assert.ok(start < end, `Expected ${startMarker} before ${endMarker}`);
  return normalized.slice(start, end);
}

describe("Android Pocket bridges", () => {
  it("defines the request-scoped Android sync bridge ABI", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/web/js/events/settings.js", import.meta.url), "utf8");

    assert.match(activity, /fun chooseSyncFolder\(token: String\?, requestId: String\?\): Boolean/);
    assert.match(activity, /fun forceSyncFolder\(token: String\?, requestId: String\?\): Boolean/);
    assert.match(activity, /fun cancelSyncFolder\(requestId: String\?\): Boolean/);
    assert.match(activity, /fun getSyncFolderLabel\(\): String\?/);
    assert.match(activity, /beginSyncRequest\(requestId, token\)/);
    assert.match(activity, /private fun rememberSyncFolder\(uri: Uri, folder: DocumentFile, persistPermission: Boolean\): String/);
    assert.match(activity, /\.put\("requestId", request\.id\)/);
    assert.match(activity, /\.put\("terminal", false\)/);
    assert.match(activity, /\.put\("terminal", true\)/);
    assert.match(activity, /\.put\("health", health\)/);
    assert.doesNotMatch(activity, /fun chooseSyncFolder\(token: String\?\)\s*\{/);
    assert.match(settings, /createAndroidSyncRequestId\(\)/);
    assert.match(settings, /detail\.requestId !== requestId/);
    assert.match(settings, /detail\.terminal === false/);
    assert.match(settings, /chooseSyncFolder\(window\.WH_TOKEN \|\| "", requestId\)/);
    assert.match(settings, /forceSyncFolder\(window\.WH_TOKEN \|\| "", requestId\)/);
    assert.match(preferences, /getAndroidSyncFolderLabel\(\)/);
  });

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

    const { openAndroidUrl } = await import("../../src/web/js/platform.js");

    assert.equal(openAndroidUrl("https://dict.test/wort"), true);
    assert.deepEqual(calls, ["https://dict.test/wort"]);

    window.WordHunterAndroid.openUrl = () => false;
    assert.equal(openAndroidUrl("https://dict.test/unhandled"), false);
    delete window.WordHunterAndroid;
    assert.equal(openAndroidUrl("https://dict.test/no-bridge"), false);
  });

  it("defines the native URL and TTS callback security contracts", () => {
    const shared = readFileSync(new URL("../../src/web/js/events/shared.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/web/app.js", import.meta.url), "utf8");
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

  it("defines Android PDF rendering and overlay integration ABIs", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
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
    assert.match(importEvents, /getAndroidPdfRendererBridge\(\)/);
    assert.match(importEvents, /renderAndSaveAndroidPdfPages\(data, id, pages\)/);
    assert.match(importEvents, /pending_import: true/);
  });

  it("requires least-privilege persisted SAF access before remembering a folder", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /Intent\(Intent\.ACTION_OPEN_DOCUMENT_TREE\)/);
    assert.match(activity, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
    assert.match(activity, /Intent\.FLAG_GRANT_WRITE_URI_PERMISSION/);
    assert.match(activity, /Intent\.FLAG_GRANT_PERSISTABLE_URI_PERMISSION/);
    assert.match(activity, /FLAG_GRANT_PREFIX_URI_PERMISSION/);
    assert.doesNotMatch(activity, /ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION/);
    assert.doesNotMatch(activity, /MANAGE_EXTERNAL_STORAGE/);
    assert.match(activity, /private fun persistSyncPermission\(uri: Uri, grantFlags: Int\): JSONObject/);
    assert.match(activity, /contentResolver\.takePersistableUriPermission\(uri, granted\)/);
    assert.match(activity, /Persisted sync folder permission is missing read\/write access/);
    assert.match(activity, /private fun verifySafSyncFolder\(uri: Uri, folder: DocumentFile, permission: JSONObject\): JSONObject/);
    assert.match(activity, /folder\.listFiles\(\)/);
    assert.match(activity, /folder\.createFile\("application\/octet-stream", probeName\)/);
    assert.match(activity, /contentResolver\.openOutputStream\(probe\.uri, "wt"\)/);
    assert.match(activity, /contentResolver\.openInputStream\(probe\.uri\)/);
    assert.match(activity, /probe\.delete\(\)/);
    assert.match(activity, /ANDROID_SYNC_MARKER_NAME = "\.wordhunter-sync\.json"/);
    assert.match(activity, /verifySyncFolderOwnership\(folder, entries\)/);
    assert.match(activity, /setOf\("\.stfolder", "\.stversions", "\.stignore"\)/);
    assert.match(activity, /Select an empty Word Hunter sync folder/);
    assertSourceOrder(activity, "verifySafSyncFolder(uri, folder, permission)", "rememberSyncFolder(uri, folder, persistPermission)");
    assertSourceOrder(activity, "rememberSyncFolder(uri, folder, persistPermission)", "prepareSyncStagingRoot(request)");
    assert.match(activity, /if \(!prefs\.commit\(\)\)/);
  });

  it("guards the Android staging endpoint and record namespace", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src-tauri/src/router.rs", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const authentication = sourceBetween(router, "fn authenticate_request(", "fn dispatch_state_independent_request(");
    const androidHandler = sourceBetween(
      handlers,
      "#[cfg(target_os = \"android\")]\npub(crate) fn sync_android_staging",
      "#[cfg(not(target_os = \"android\"))]"
    );

    assert.match(activity, /URL\("http:\/\/127\.0\.0\.1:38619\/__store\/sync_android_staging"\)/);
    assert.match(activity, /connection\.setRequestProperty\("X-WH-Token", syncToken\)/);
    assert.match(authentication, /request\.method\(\) == &Method::Post/);
    assert.match(authentication, /path != "\/__log_error"/);
    assert.match(authentication, /!response::valid_token\(&request, token\)/);
    assertSourceOrder(
      router,
      "authenticate_request(request, &path, &state.token)",
      "\"/__store/sync_android_staging\"",
      "Android staging must remain behind POST token validation"
    );
    assert.match(router, /"\/__store\/sync_android_staging" => \{[\s\S]*handlers::sync_android_staging\(&state, &payload\)/);
    assert.match(androidHandler, /payload[\s\S]*"requestId"/);
    assert.match(androidHandler, /std::fs::canonicalize\(&staging_parent\)/);
    assert.match(androidHandler, /std::fs::canonicalize\(&staging_root\)/);
    assert.match(androidHandler, /std::fs::canonicalize\(&incoming_dir\)/);
    assert.match(androidHandler, /!staging_root\.starts_with\(&staging_parent\)/);
    assert.match(androidHandler, /!incoming_dir\.starts_with\(&staging_root\)/);
    assert.match(androidHandler, /recover_pending_save_guarded\(\)/);
    assert.match(androidHandler, /sync_with_directory\(incoming_dir\.clone\(\)\)/);
    assert.doesNotMatch(androidHandler, /"snapshot"/);
    assert.match(activity, /private val recordDataNames = setOf\("records"\)/);
    assert.match(activity, /private val mediaDataNames = setOf\("books"\)/);
    assert.match(activity, /private val knownDataNames = recordDataNames \+ mediaDataNames/);
    assert.doesNotMatch(activity, /knownDataNames = setOf\([^\n]*"argos-packages"/);
    assert.match(activity, /private val skippedBookRecordNames = setOf\("book\.json", "book\.bak", "metadata\.json", "text\.txt"\)/);
    assert.match(activity, /private fun shouldSyncRelativePath\(relativePath: String, isDirectory: Boolean, recordsOnly: Boolean\): Boolean/);
    assert.match(activity, /recordsOnly && rootName !in recordDataNames/);
    assert.match(activity, /rootName !in knownDataNames/);
    assert.doesNotMatch(activity, /"store\.sqlite"/);
    assert.doesNotMatch(activity, /"vocab\.json"/);
    assert.doesNotMatch(activity, /"save-journal\.json"/);
    assert.doesNotMatch(activity, /"device-id\.txt"/);
    assert.match(activity, /copyDocumentTreeToFile\([\s\S]*root = true,[\s\S]*recordsOnly = false/);
    assert.match(activity, /copyFileTreeToDocument\([\s\S]*root = true,[\s\S]*recordsOnly = false/);
    assert.match(activity, /"assets"/);
  });

  it("defines temporary-document replacement guards for SAF writes", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /private fun copyFileToDocument\(/);
    assert.match(activity, /existing: DocumentFile\?/);
    assert.match(activity, /request: SyncRequest/);
    assert.match(activity, /val tempName = "\$\{source\.name\}\.tmp"/);
    assert.match(activity, /val expectedLength = source\.length\(\)/);
    assertSourceOrder(activity, "target.createFile(mimeFor(source.name), tempName)", "replaceDocumentWithTemp(");
    assert.match(activity, /while \(true\) \{[\s\S]*ensureSyncActive\(request\)[\s\S]*input\.read\(buffer\)/);
    assertSourceOrder(activity, "val current = target.findFile(source.name)", "replaceDocumentWithTemp(");
    assert.match(activity, /private fun replaceDocumentWithTemp\([\s\S]*expectedDigest: ByteArray\?/);
    assert.match(activity, /backupDigest\.contentEquals\(expectedDigest\)/);
    assert.match(activity, /existing\.renameTo\(backupName\)/);
    assert.match(activity, /temp\.renameTo\(finalName\)/);
    assert.match(activity, /if \(!existing\.renameTo\(finalName\)\)/);
  });

  it("synchronizes changed records instead of comparing filenames only", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /private fun recordContentsEqual\(source: File, existing: DocumentFile\): Boolean/);
    assert.match(activity, /streamsEqual\(sourceInput, existingInput\)/);
    assert.doesNotMatch(activity, /kotlin\.math\.abs\(sourceModified - existingModified\)/);
    assert.doesNotMatch(activity, /expectedLength >= 262144L\) return true/);
    assert.match(activity, /syncRecordDirectoryNames = setOf\(/);
    assert.doesNotMatch(activity, /syncRecordDirectoryNames = setOf\([^)]*"prefs"/s);
  });

  it("bounds Android staging and mirrors media tombstones back to SAF", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /ANDROID_SYNC_MAX_ENTRIES = 100000/);
    assert.match(activity, /ANDROID_SYNC_MAX_DEPTH = 8/);
    assert.match(activity, /ANDROID_SYNC_MAX_FILE_BYTES = 256L \* 1024L \* 1024L/);
    assert.match(activity, /ANDROID_SYNC_MAX_TOTAL_BYTES = 2L \* 1024L \* 1024L \* 1024L/);
    assert.match(activity, /stats\.visitRemote\(childRelativePath\)/);
    assert.match(activity, /stats\.ensureCanStage\(relativePath, copied\)/);
    assert.match(activity, /deleteManagedDocumentEntry\(child, childRelativePath, recordsOnly, request, stats\)/);
    assert.match(activity, /ensureRemoteFileUnchanged\(relativePath, existing, stats\)/);
    assert.match(activity, /initialRemoteFileDigests/);
    assert.match(activity, /File\(stagingParent, request\.id\)/);
    assert.match(activity, /connection\.readTimeout = 0/);
    assert.match(activity, /request\.backendInProgress/);
    assert.match(activity, /Cannot list local sync staging path/);
    assert.match(activity, /validateLocalExportTree\(incomingDir, stats, root = true\)/);
    assert.match(activity, /isObsoleteLocalOnlySyncPath\(childRelativePath\)/);
  });

  it("defines the Android create-document export ABI", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const syncActions = readFileSync(new URL("../../src/web/js/sync-actions.js", import.meta.url), "utf8");

    assert.match(activity, /fun saveExport\(data: String\?, filename: String\?, mime: String\?, requestId: String\?\): Boolean/);
    assert.match(activity, /private val exportDocumentLauncher = registerForActivityResult\(/);
    assert.match(activity, /exportDocumentLauncher\.launch\(createExportDocumentIntent\(/);
    assert.match(activity, /Intent\(Intent\.ACTION_CREATE_DOCUMENT\)/);
    assert.match(activity, /Intent\.CATEGORY_OPENABLE/);
    assert.match(activity, /Intent\.EXTRA_TITLE/);
    assert.match(activity, /openFileDescriptor\(uri, "wt"\)/);
    assert.match(activity, /output\.fd\.sync\(\)/);
    assert.match(syncActions, /WordHunterAndroid\?\.saveExport/);
    assert.match(syncActions, /wordhunter:android-export/);
    assert.match(syncActions, /detail\.requestId !== requestId/);
    assert.match(syncActions, /window\.WordHunterAndroid\.saveExport\(data, filename, mime, requestId\)/);
  });
});
