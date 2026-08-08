#!/usr/bin/env node
// Portable Android version patcher (Linux/macOS/CI/F-Droid): computes the
// versionCode from tauri.conf.json with the same formula as scripts/build.bat
// (versionCode = 1_000_000 + base*100 + releaseOrdinal) and stamps it plus
// versionName into the generated AndroidManifest.xml. Idempotent.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");

const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = String(config.version ?? "").split("+")[0];
const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch) || minor >= 1000 || patch >= 1000) {
  throw new Error(`Invalid version for the Android versionCode formula: ${version}`);
}
const releaseOrdinal = Number.parseInt(process.env.WH_ANDROID_RELEASE_ORDINAL || "0", 10) || 0;
// Same formula as scripts/build.bat: baseCode = major*1e6 + minor*1e3 + patch.
const baseCode = major * 1_000_000 + minor * 1_000 + patch;
const versionCode = 1_000_000 + baseCode * 100 + releaseOrdinal;
if (versionCode < 1 || versionCode > 2_100_000_000) {
  throw new Error(`versionCode out of range: ${versionCode}`);
}

const manifest = readFileSync(manifestPath, "utf8");
const patched = manifest
  .replace(/(android:versionCode=")\d+(")/, `$1${versionCode}$2`)
  .replace(/(android:versionName=")[^"]*(")/, `$1${version}$2`);
if (patched === manifest) {
  throw new Error("AndroidManifest.xml: expected versionCode/versionName attributes not found");
}
writeFileSync(manifestPath, patched);
console.log(`android versionCode=${versionCode} versionName=${version} -> ${manifestPath}`);
