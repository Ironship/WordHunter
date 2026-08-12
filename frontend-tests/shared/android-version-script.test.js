import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NDK_VERSION,
  androidVersionFor,
  checkNeutralGradle,
  checkTauriProperties,
  neutralizeGradle,
  tauriPropertiesFor,
} from "../../scripts/android-version.mjs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const androidConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.android.conf.json", import.meta.url), "utf8"),
);

// The OLD Windows-stamped shape (literal identity baked in) and the neutral shape the
// committed gen/android project must keep.
const literalGradle = `android {
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

const neutralGradle = `android {
    namespace = "com.wordhunter.pocket"
    compileSdk = 36
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "com.wordhunter.pocket"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
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

  it("maps the +1 hotfix to ordinal 100 and keeps the raw version name (the Tauri CLI writes the raw config version)", () => {
    assert.equal(androidVersionFor("1.0.10+1").code, 101001100);
    assert.equal(androidVersionFor("1.0.10+1").name, "1.0.10+1");
    assert.throws(() => androidVersionFor("1.0.10+2"), /hotfix/);
  });

  it("pins the tauri.conf.json contract the identity derives from", () => {
    assert.equal(tauriConfig.version, "1.0.11-rc.1");
    assert.equal(androidVersionFor(tauriConfig.version).code, 101001101);
  });

  it("pins tauri.android.conf.json bundle.android.versionCode — the value the Tauri CLI writes into tauri.properties", () => {
    assert.equal(androidConfig.bundle.android.versionCode, androidVersionFor(tauriConfig.version).code);
  });

  it("neutralizes baked literals back to the tauriProperties indirection", () => {
    const neutralized = neutralizeGradle(literalGradle);
    assert.doesNotMatch(neutralized, /versionCode = 100000909/);
    assert.doesNotMatch(neutralized, /versionName = "1\.0\.9-rc\.9"/);
    assert.match(
      neutralized,
      /versionCode = tauriProperties\.getProperty\("tauri\.android\.versionCode", "1"\)\.toInt\(\)/,
    );
    assert.match(
      neutralized,
      /versionName = tauriProperties\.getProperty\("tauri\.android\.versionName", "1\.0"\)/,
    );
    // The ndkVersion pin (issue #144) is carried by the committed build.gradle.kts and
    // enforced by checkNeutralGradle — neutralizeGradle must never insert it (a regex
    // insert once merged the namespace and ndkVersion lines, issue #209).
    assert.doesNotMatch(neutralized, /ndkVersion/);
  });

  it("is idempotent on the neutral form", () => {
    assert.equal(neutralizeGradle(neutralGradle), neutralGradle);
  });

  it("--check hard-fails on baked literals, missing indirection, or a missing ndkVersion", () => {
    assert.throws(() => checkNeutralGradle(literalGradle), /literal versionCode/);
    const onlyNameLiteral = literalGradle.replace(
      /versionCode = 100000909/,
      'versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()',
    );
    assert.throws(() => checkNeutralGradle(onlyNameLiteral), /literal versionName/);
    const noNdk = neutralGradle.replace(/ndkVersion = "[^"]+"/, "");
    assert.throws(() => checkNeutralGradle(noNdk), /ndkVersion/);
    assert.doesNotThrow(() => checkNeutralGradle(neutralGradle));
  });

  it("writes the tauri.properties identity and hard-fails the check when it drifts", () => {
    const versionInfo = androidVersionFor("1.0.10");
    const properties = tauriPropertiesFor(versionInfo);
    assert.match(properties, /tauri\.android\.versionName=1\.0\.10/);
    assert.match(properties, /tauri\.android\.versionCode=101001099/);
    assert.doesNotThrow(() => checkTauriProperties(properties, versionInfo));
    assert.throws(
      () => checkTauriProperties(properties.replace("101001099", "1000010"), versionInfo),
      /versionCode=101001099/,
    );
    assert.throws(
      () => checkTauriProperties(properties.replace("1.0.10", "9.9.9"), versionInfo),
      /versionName=1\.0\.10/,
    );
  });

  it("stays consistent with the scripts/build.bat formula and the neutral Windows recipe", () => {
    const bat = readFileSync(new URL("../../scripts/build.bat", import.meta.url), "utf8");
    assert.match(bat, /versionCodeGenerationOffset = 1000000/);
    assert.match(bat, /\$code = \$versionCodeGenerationOffset \+ \(\$baseCode \* 100\) \+ \$releaseOrdinal/);
    assert.match(bat, /\$releaseOrdinal = 99/, "stable ordinal");
    assert.match(bat, /\$releaseOrdinal = 100/, "hotfix ordinal");
    assert.match(bat, /\bName = \$version\.Replace\('\+'/, "hotfix versionName rewrites + to .");
    assert.match(bat, /\.template-version/, "Ensure-AndroidProject template marker");
    assert.match(bat, /android-version\.mjs", "--check"/, "Windows recipe verifies via the portable check");
    assert.doesNotMatch(bat, /Set-AndroidGradleVersion/, "literal stamping removed");
    assert.doesNotMatch(bat, /documentfile/, "unused dependency injection removed");
  });
});
