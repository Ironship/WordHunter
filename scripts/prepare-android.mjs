#!/usr/bin/env node
// Portable Android project preparation (Linux CI / F-Droid): applies the same overlay that
// scripts/build.bat Prepare-AndroidProject applies on Windows, without PowerShell:
//   * copies the tracked src-tauri/platforms/android overrides into the committed
//     gen/android project (MainActivity.kt, AndroidManifest.xml, network_security_config.xml,
//     res/xml/file_paths.xml);
//   * writes the day/night themes (values/ + values-night/themes.xml);
//   * drops a stale OCR runtime from the packaged assets if present;
//   * runs scripts/android-version.mjs to write app/tauri.properties and enforce the neutral
//     gradle form, then verifies everything with --check.
// Launcher icons and the rest of gen/android are COMMITTED (see gen/android/.template-version),
// so no tauri-cli install or network access is needed on the build host.
//
// Usage (F-Droid-style recipe, after `npm ci && npm run build:frontend` and a cargo build of
// the aarch64-linux-android Rust lib — that cargo build makes tauri-build write
// tauri.settings.gradle/tauri.build.gradle.kts into gen/android):
//   node scripts/prepare-android.mjs
//   cd src-tauri/gen/android && ./gradlew assembleRelease -PabiList=arm64-v8a
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const genApp = join(root, "src-tauri", "gen", "android", "app");
const platforms = join(root, "src-tauri", "platforms", "android");

// Same day/night theme scripts/build.bat Prepare-AndroidProject writes (issue #143 bullet 8).
const THEMES_XML = `<resources>
    <style name="Theme.word_hunter" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowBackground">#0d1114</item>
        <item name="android:statusBarColor">#0d1114</item>
        <item name="android:navigationBarColor">#071724</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>
</resources>
`;

const overlays = [
  ["MainActivity.kt", "src/main/java/com/wordhunter/pocket/MainActivity.kt"],
  ["AndroidManifest.xml", "src/main/AndroidManifest.xml"],
  ["network_security_config.xml", "src/main/res/xml/network_security_config.xml"],
  ["res/xml/file_paths.xml", "src/main/res/xml/file_paths.xml"],
];

function main() {
  const gradlePath = join(genApp, "build.gradle.kts");
  if (!existsSync(gradlePath)) {
    throw new Error(
      `${gradlePath} not found: the committed gen/android project is missing (restore it from git first)`,
    );
  }
  for (const [sourceRel, targetRel] of overlays) {
    const source = join(platforms, sourceRel);
    const target = join(genApp, targetRel);
    if (!existsSync(source)) {
      throw new Error(`${source} not found: tracked Android overlay is incomplete`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  for (const valuesDir of ["values", "values-night"]) {
    const target = join(genApp, "src", "main", "res", valuesDir, "themes.xml");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, THEMES_XML);
  }
  rmSync(join(genApp, "src", "main", "assets", "ocr-runtime"), {
    recursive: true,
    force: true,
  });
  for (const args of [
    ["scripts/android-version.mjs"],
    ["scripts/android-version.mjs", "--check"],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
  console.log("Android project prepared: overlay applied, version identity stamped and verified");
}

main();
