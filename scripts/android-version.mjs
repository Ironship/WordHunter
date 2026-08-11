#!/usr/bin/env node
// Portable Android version patcher (Linux/macOS/CI/F-Droid): computes the
// versionCode/versionName from src-tauri/tauri.conf.json with the same
// formula as scripts/build.bat Get-AndroidVersionInfo and stamps them into
// gen/android/app/build.gradle.kts — the same file Set-AndroidGradleVersion
// patches on Windows (scripts/build.bat:550-566). Idempotent.
//
// The versionCode formula (see scripts/build.bat Get-AndroidVersionInfo and
// scripts/inspect-artifact.mjs androidVersionCodeFor) is
//   1000000 + ((major*1e6 + minor*1e3 + patch) * 100) + releaseOrdinal
// where releaseOrdinal is 99 for a stable release, the rc number for
// -rc.N, and 100 for a +1 hotfix. 1.0.10 -> 101001099.
//
// Usage:
//   node scripts/android-version.mjs            # patch gen/android gradle
//   node scripts/android-version.mjs --check    # verify, fail if stale
// Run it after the Android project has been generated (`tauri android init`,
// or any scripts/build.bat android invocation). `--check` is wired into
// .github/workflows/artifact-validation.yml after the AAB build to verify the
// on-disk gradle identity independently of Set-AndroidGradleVersion.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { androidVersionCodeFor } from "./inspect-artifact.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gradlePath = join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts");

// Mirrors scripts/build.bat Get-AndroidVersionInfo's Name derivation:
// MAJOR.MINOR.PATCH+1 renders as versionName "MAJOR.MINOR.PATCH.1".
export function androidVersionFor(version) {
  return {
    source: version,
    name: version.replace("+", "."),
    code: androidVersionCodeFor(version),
  };
}

// Mirrors scripts/build.bat Set-AndroidGradleVersion (build.bat:550-566):
// rewrites the `versionCode = N` / `versionName = "..."` lines and hard-fails
// when they are absent so a stale template can never silently ship. Returns
// the input unchanged when the identity is already correct (idempotent).
export function patchGradleVersion(gradleText, versionInfo) {
  const codeLine = /^(\s*)versionCode\s*=\s*.+$/m.test(gradleText);
  const nameLine = /^(\s*)versionName\s*=\s*.+$/m.test(gradleText);
  if (!codeLine || !nameLine) {
    throw new Error(
      "gen/android/app/build.gradle.kts: expected versionCode/versionName lines not found",
    );
  }
  return gradleText
    .replace(/^(\s*)versionCode\s*=\s*.+$/m, `$1versionCode = ${versionInfo.code}`)
    .replace(/^(\s*)versionName\s*=\s*.+$/m, `$1versionName = "${versionInfo.name}"`);
}

function readGradleOrFail() {
  try {
    return readFileSync(gradlePath, "utf8");
  } catch (error) {
    throw new Error(
      `gen/android/app/build.gradle.kts not found (${gradlePath}): run 'tauri android init' or scripts/build.bat once to generate the Android project`,
      { cause: error },
    );
  }
}

function main() {
  const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const versionInfo = androidVersionFor(String(config.version));
  const gradleText = readGradleOrFail();
  const patched = patchGradleVersion(gradleText, versionInfo);
  if (process.argv.includes("--check")) {
    if (patched !== gradleText) {
      throw new Error(
        `gen/android/app/build.gradle.kts is out of date: expected versionCode=${versionInfo.code} versionName="${versionInfo.name}"`,
      );
    }
    console.log(
      `android version identity OK: versionCode=${versionInfo.code} versionName=${versionInfo.name}`,
    );
  } else {
    writeFileSync(gradlePath, patched);
    console.log(`android versionCode=${versionInfo.code} versionName=${versionInfo.name} -> ${gradlePath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
