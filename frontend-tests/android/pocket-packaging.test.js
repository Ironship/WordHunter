import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("Android Pocket packaging", () => {
  it("keeps the Android package Play-friendly", () => {
    const androidConfig = readFileSync(new URL("../../src-tauri/tauri.android.conf.json", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../../src-tauri/platforms/android/AndroidManifest.xml", import.meta.url), "utf8");
    const build = readFileSync(new URL("../../scripts/build.bat", import.meta.url), "utf8");
    const sources = readFileSync(new URL("../../src/web/js/book-actions/sources.js", import.meta.url), "utf8");
    const platformMod = readFileSync(new URL("../../src-tauri/src/platform/mod.rs", import.meta.url), "utf8");
    const webApp = readFileSync(new URL("../../src-tauri/src/platform/web_app.rs", import.meta.url), "utf8");
    const androidSetup = readFileSync(new URL("../../src-tauri/src/platform/android.rs", import.meta.url), "utf8");
    const handlers = readFileSync(new URL("../../src-tauri/src/handlers.rs", import.meta.url), "utf8");
    const buildRs = readFileSync(new URL("../../src-tauri/build.rs", import.meta.url), "utf8");
    const mainActivity = readFileSync(new URL("../../src-tauri/platforms/android/MainActivity.kt", import.meta.url), "utf8");
    const index = readFileSync(new URL("../../src/web/index.html", import.meta.url), "utf8");

    assert.doesNotMatch(androidConfig, /ocr-runtime/);
    assert.match(androidConfig, /"create": false/);
    assert.match(androidConfig, /"url": "http:\/\/127\.0\.0\.1:38619\/index\.html"/);
    assert.match(androidSetup, /const ANDROID_SERVER_PORT: u16 = 38619/);
    assert.match(androidSetup, /start_server_on_port/);
    assert.match(androidSetup, /WebviewWindowBuilder::from_config/);
    assert.doesNotMatch(manifest, /LEANBACK|FileProvider|file_paths/);
    assert.match(build, /Word\.Hunter\.Pocket\.release\.aab/);
    assert.match(build, /cargo\.exe" @\("tauri", "android", "build", "--aab"/);
    assert.match(build, /WH_ANDROID_KEYSTORE/);
    assert.match(build, /jarsigner\.exe/);
    assert.match(build, /"play" { Build-AndroidReleaseAab -RequireSigning }/);
    assert.match(build, /android:windowBackground/);
    assert.match(build, /#0d1114/);
    assert.match(platformMod, /#\[cfg\(not\(target_os = "android"\)\)\]\s*mod web_app;/);
    assert.match(webApp, /use tauri::webview::PageLoadEvent/);
    assert.match(webApp, /\.visible\(false\)[\s\S]*PageLoadEvent::Finished/);
    assert.match(buildRs, /rerun-if-changed=\.\.\/src\/web/);
    assert.match(handlers, /serve_static[\s\S]*response::respond\(request, 200, file\.contents\(\)\.to_vec\(\), &mime, false\)/);
    assert.match(mainActivity, /webView\.clearCache\(true\)/);
    assert.match(index, /styles\.css\?v=20260629-ui-cache/);
    assert.match(index, /android-pocket\.css\?v=20260629-ui-cache/);
    assert.match(sources, /\/__proxy\?url=/);
    assert.doesNotMatch(sources, /corsproxy|allorigins|r\.jina/);
  });
});
