import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { androidVersionFor, patchGradleVersion } from "../../scripts/android-version.mjs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

const gradleTemplate = `android {
    namespace = "com.wordhunter.pocket"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.wordhunter.pocket"
        minSdk = 26
        targetSdk = 36
        versionCode = 100000909
        versionName = "1.0.9-rc.9"
    }
}
`;

describe("android-version.mjs portable version identity (F-Droid/CI patcher)", () => {
  it("mirrors scripts/build.bat Get-AndroidVersionInfo for stable releases", () => {
    assert.equal(androidVersionFor("1.0.10").code, 101001099);
    assert.equal(androidVersionFor("1.0.10").name, "1.0.10");
    assert.equal(androidVersionFor("1.0.9").code, 101000999);
  });

  it("maps -rc.N to the rc ordinal", () => {
    assert.equal(androidVersionFor("1.0.10-rc.1").code, 101001001);
    assert.equal(androidVersionFor("1.0.9-rc.9").code, 101000909);
    assert.equal(androidVersionFor("1.0.10-rc.1").name, "1.0.10-rc.1");
    assert.throws(() => androidVersionFor("1.0.10-rc.99"), /ordinal/);
    assert.throws(() => androidVersionFor("1.0.10-rc.0"), /ordinal/);
  });

  it("maps the +1 hotfix to ordinal 100 and rewrites the versionName dot", () => {
    assert.equal(androidVersionFor("1.0.10+1").code, 101001100);
    assert.equal(androidVersionFor("1.0.10+1").name, "1.0.10.1");
    assert.throws(() => androidVersionFor("1.0.10+2"), /hotfix/);
  });

  it("pins the tauri.conf.json contract the patcher reads from", () => {
    assert.equal(tauriConfig.version, "1.0.10");
    assert.equal(androidVersionFor(tauriConfig.version).code, 101001099);
  });

  it("rewrites versionCode/versionName in build.gradle.kts like Set-AndroidGradleVersion", () => {
    const patched = patchGradleVersion(gradleTemplate, androidVersionFor("1.0.10"));
    assert.match(patched, /^\s*versionCode = 101001099\s*$/m);
    assert.match(patched, /^\s*versionName = "1\.0\.10"\s*$/m);
    assert.doesNotMatch(patched, /100000909|1\.0\.9-rc\.9/);
  });

  it("hard-fails when the gradle identity lines are absent (committed template must carry them)", () => {
    assert.throws(
      () => patchGradleVersion("android { defaultConfig { } }", androidVersionFor("1.0.10")),
      /versionCode\/versionName lines not found/,
    );
  });

  it("stays consistent with the scripts/build.bat formula", () => {
    const bat = readFileSync(new URL("../../scripts/build.bat", import.meta.url), "utf8");
    assert.match(bat, /versionCodeGenerationOffset = 1000000/);
    assert.match(bat, /\$code = \$versionCodeGenerationOffset \+ \(\$baseCode \* 100\) \+ \$releaseOrdinal/);
    assert.match(bat, /\$releaseOrdinal = 99/, "stable ordinal");
    assert.match(bat, /\$releaseOrdinal = 100/, "hotfix ordinal");
    assert.match(bat, /\bName = \$version\.Replace\('\+'/, "hotfix versionName rewrites + to .");
  });
});
