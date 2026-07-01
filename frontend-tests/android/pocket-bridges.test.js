import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  it("syncs a selected folder without replacing app data", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const preferences = readFileSync(new URL("../../src/web/js/preferences.js", import.meta.url), "utf8");

    assert.match(activity, /Executors\.newSingleThreadExecutor\(\)/);
    assert.match(activity, /syncExecutor\.execute \{[\s\S]*syncSelectedFolder\(uri\)/);
    assert.match(activity, /fun forceSyncFolder\(\): Boolean/);
    assert.match(activity, /fun getSyncFolderLabel\(\): String\?/);
    assert.match(activity, /getSharedPreferences\("wordhunter-sync", MODE_PRIVATE\)/);
    assert.match(activity, /folder\.name\?\.takeIf \{ it\.isNotBlank\(\) \} \?: uri\.toString\(\)/);
    assert.match(activity, /\.putString\("sync_label", label\)/);
    assert.match(activity, /copyDocumentTreeToFile\(folder, appDir, root = true\)/);
    assert.match(activity, /copyFileTreeToDocument\(appDir, folder, root = true\)/);
    assert.match(activity, /if \(root && name !in knownDataNames\) return@forEach/);
    assert.match(activity, /private fun shouldCopyDocumentFile\(source: DocumentFile, destination: File\): Boolean/);
    assert.match(activity, /isSyncRecordFile\(destination\)[\s\S]*remoteClock > localClock/);
    assert.match(activity, /isSyncRecordFile\(source\)[\s\S]*localClock <= remoteClock\) return/);
    assert.match(activity, /private fun syncRecordClock\(raw: String\?\): Long\?/);
    assert.match(preferences, /getAndroidSyncFolderLabel\(\)/);
    assert.match(preferences, /state\.syncDirectory \|\| getAndroidSyncFolderLabel\(\)/);
    assert.doesNotMatch(activity, /"argos-packages"/);
    assert.doesNotMatch(activity, /importDocumentTreeToAppData\(folder, appDir\)/);
    assert.doesNotMatch(activity, /WordHunter\.importing/);
    assert.doesNotMatch(activity, /clearWordHunterDir\(appDir\)[\s\S]*copyDocumentTreeToFile\(folder, appDir\)/);
  });

  it("exports Pocket files through a temporary document before replacing cloud files", () => {
    const activity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");

    assert.match(activity, /private fun copyFileToDocument\(source: File, target: DocumentFile\)/);
    assert.match(activity, /val tempName = "\$\{source\.name\}\.tmp"/);
    assert.match(activity, /copyFileToDocument\(child, target\)/);
    assert.match(activity, /copyFileTreeToDocument\(appDir, folder, root = true\)/);
    assert.match(activity, /if \(root && child\.name !in knownDataNames\) return@forEach/);
    assert.ok(activity.indexOf("target.createFile(mimeFor(source.name), tempName)") < activity.indexOf("existing?.delete()"));
    assert.match(activity, /temp\.renameTo\(source\.name\)/);
  });
});
