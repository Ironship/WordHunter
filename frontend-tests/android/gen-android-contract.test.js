import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NDK_VERSION, androidVersionFor, checkNeutralGradle } from "../../scripts/android-version.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const gen = join(root, "src-tauri", "gen", "android");
const platforms = join(root, "src-tauri", "platforms", "android");

const read = (path) => readFileSync(path, "utf8");

const tracked = (rel) =>
  execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: root,
    stdio: "pipe",
  })
    .toString()
    .trim();

describe("committed gen/android contract (issue #209 hybrid)", () => {
  it("tracks the generated Android project in git", () => {
    assert.equal(
      tracked("src-tauri/gen/android/app/build.gradle.kts"),
      "src-tauri/gen/android/app/build.gradle.kts",
    );
    assert.equal(
      tracked("src-tauri/gen/android/.template-version"),
      "src-tauri/gen/android/.template-version",
    );
  });

  it("keeps build.gradle.kts version-neutral with the ndkVersion pin", () => {
    const gradle = read(join(gen, "app", "build.gradle.kts"));
    assert.doesNotThrow(() => checkNeutralGradle(gradle));
    assert.match(gradle, new RegExp(`ndkVersion = "${NDK_VERSION}"`));
    assert.match(
      gradle,
      new RegExp(`namespace = "com\\.wordhunter\\.pocket"\\r?\\n\\s*ndkVersion = "${NDK_VERSION}"`),
      "namespace and ndkVersion must stay separate lines (regression: the ndkVersion insertion once merged them)",
    );
    assert.match(
      gradle,
      /packaging \{\r?\n\s+jniLibs\.keepDebugSymbols\.add\("\*\/arm64-v8a\/\*\.so"\)/,
      "packaging { must stay on its own line (regression: merged with the first jniLibs entry)",
    );
  });

  it("carries the template-version marker of the pinned Tauri CLI", () => {
    assert.equal(read(join(gen, ".template-version")).trim(), "tauri-cli 2.11.4");
  });

  it("commits the platforms/android overlay copies in sync", () => {
    const normalize = (text) => text.replace(/\r\n/g, "\n");
    for (const [sourceRel, targetRel] of [
      ["MainActivity.kt", "app/src/main/java/com/wordhunter/pocket/MainActivity.kt"],
      ["AndroidManifest.xml", "app/src/main/AndroidManifest.xml"],
      ["network_security_config.xml", "app/src/main/res/xml/network_security_config.xml"],
      ["res/xml/file_paths.xml", "app/src/main/res/xml/file_paths.xml"],
    ]) {
      assert.equal(
        normalize(read(join(gen, targetRel))),
        normalize(read(join(platforms, sourceRel))),
        `${targetRel} must mirror the tracked platforms/${sourceRel} overlay`,
      );
    }
  });

  it("commits the day/night themes", () => {
    for (const valuesDir of ["values", "values-night"]) {
      const themes = read(join(gen, "app", "src", "main", "res", valuesDir, "themes.xml"));
      assert.match(themes, /Theme\.word_hunter/);
      assert.match(themes, /Theme\.MaterialComponents\.DayNight\.NoActionBar/);
    }
  });

  it("derives the identity the committed project will stamp from the config pair", () => {
    const tauriConfig = JSON.parse(read(join(root, "src-tauri", "tauri.conf.json")));
    const androidConfig = JSON.parse(read(join(root, "src-tauri", "tauri.android.conf.json")));
    assert.equal(
      androidConfig.bundle.android.versionCode,
      androidVersionFor(String(tauriConfig.version)).code,
    );
  });

  it("gitignores the CLI/tauri-build regenerated files inside gen/android", () => {
    const appGitignore = read(join(gen, "app", ".gitignore"));
    assert.match(appGitignore, /tauri\.properties/);
    assert.match(appGitignore, /tauri\.build\.gradle\.kts/);
    assert.match(appGitignore, /generated/);
    assert.match(appGitignore, /src\/main\/assets/);
    const rootGitignore = read(join(gen, ".gitignore"));
    assert.match(rootGitignore, /tauri\.settings\.gradle/);
  });
});
