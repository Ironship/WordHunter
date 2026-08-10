import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  androidVersionCodeFor,
  isBadgingDebuggable,
  parseBadgingPackage,
  parseXmlTreeManifest,
} from "../../scripts/inspect-artifact.mjs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

const androidConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.android.conf.json", import.meta.url), "utf8"),
);

const releaseBadging = `package: name='com.wordhunter.pocket' versionCode='1000010' versionName='1.0.10' compileSdkVersion='36' compileSdkVersionCodename='REL' platformBuildVersionName='15' platformBuildVersionCode='35' platformBuildVersionCodename='REL'
sdkVersion:'24'
targetSdkVersion:'36'
application-label:'Word Hunter'
application-label-pl:'Word Hunter'
application: label='Word Hunter' icon='res/mipmap-anydpi-v26/ic_launcher.xml' roundIcon='res/mipmap-anydpi-v26/ic_launcher_round.xml'
launchable-activity: name='com.wordhunter.app.MainActivity' label='' icon=''
feature-group: label=''
  uses-feature: name='android.hardware.faketouch'
  uses-implied-feature: name='android.hardware.faketouch' reason='default feature for all apps'
supports-screens: 'default' 'small' 'normal' 'large' 'xlarge'
supports-any-density: 'true'
locales: '--_--' 'pl' 'en'
densities: '160' '420'
native-code: 'arm64-v8a'
`;

const debugBadging = releaseBadging.replace(
  "launchable-activity:",
  "application-debuggable\nlaunchable-activity:",
);

const releaseXmlTree = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=1)
    A: package="com.wordhunter.app" (Raw: "com.wordhunter.app")
    A: android:versionCode(0x0101021b)=(type 0x10)0xf424a
    A: android:versionName(0x0101021c)="1.0.10" (Raw: "1.0.10")
    A: android:compileSdkVersion(0x01010572)=(type 0x10)0x24
    E: application (line=2)
      A: android:label(0x01010001)="Word Hunter" (Raw: "Word Hunter")
      E: activity (line=3)
`;

const debugXmlTree = releaseXmlTree.replace(
  "A: android:versionCode(0x0101021b)=(type 0x10)0xf424a",
  "A: android:versionCode(0x0101021b)=(type 0x10)0xf424a\n    A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff",
);

describe("Android release artifact assertions", () => {
  it("derives the Android versionCode the way tauri-cli 2.11.4 does", () => {
    assert.equal(androidVersionCodeFor("1.0.10"), 1000010);
    assert.equal(androidVersionCodeFor("1.0.9"), 1000009);
    assert.equal(androidVersionCodeFor("1.0.10-rc.1"), 1000010);
    assert.throws(() => androidVersionCodeFor("not-a-version"), /Cannot derive/);
  });

  it("pins the tauri.conf.json contract the APK/AAB assertions rely on", () => {
    assert.equal(tauriConfig.identifier, "com.wordhunter.app");
    assert.equal(tauriConfig.version, "1.0.10");
    assert.equal(androidVersionCodeFor(tauriConfig.version), 1000010);
    // The Android overlay overrides the package name (Word.Hunter.Pocket);
    // androidExpectations() must use it, not the desktop identifier.
    assert.equal(androidConfig.identifier, "com.wordhunter.pocket");
  });

  it("parses aapt2 dump badging and flags debuggable APKs", () => {
    assert.deepEqual(parseBadgingPackage(releaseBadging), {
      name: "com.wordhunter.pocket",
      versionCode: 1000010,
      versionName: "1.0.10",
    });
    assert.equal(parseBadgingPackage("not badging output"), null);
    assert.equal(isBadgingDebuggable(releaseBadging), false);
    assert.equal(isBadgingDebuggable(debugBadging), true);
  });

  it("parses aapt2 dump xmltree for the AAB manifest", () => {
    assert.deepEqual(parseXmlTreeManifest(releaseXmlTree), {
      versionCode: 1000010,
      versionName: "1.0.10",
      debuggable: false,
    });
    assert.equal(parseXmlTreeManifest(debugXmlTree).debuggable, true);
  });
});
