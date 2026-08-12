import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  androidVersionCodeFor,
  isBadgingDebuggable,
  parseAxmlManifest,
  parseBadgingPackage,
  parseProtoManifest,
  parseTextManifest,
  parseXmlTreeManifest,
} from "../../scripts/inspect-artifact.mjs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

const androidConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.android.conf.json", import.meta.url), "utf8"),
);

const releaseBadging = `package: name='com.wordhunter.pocket' versionCode='101001099' versionName='1.0.10' compileSdkVersion='36' compileSdkVersionCodename='REL' platformBuildVersionName='15' platformBuildVersionCode='35' platformBuildVersionCodename='REL'
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
    A: android:versionCode(0x0101021b)=(type 0x10)0x605278b
    A: android:versionName(0x0101021c)="1.0.10" (Raw: "1.0.10")
    A: android:compileSdkVersion(0x01010572)=(type 0x10)0x24
    E: application (line=2)
      A: android:label(0x01010001)="Word Hunter" (Raw: "Word Hunter")
      E: activity (line=3)
`;

const debugXmlTree = releaseXmlTree.replace(
  "A: android:versionCode(0x0101021b)=(type 0x10)0x605278b",
  "A: android:versionCode(0x0101021b)=(type 0x10)0x605278b\n    A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff",
);

describe("Android release artifact assertions", () => {
  it("derives the Android versionCode the way tauri-cli 2.11.4 does", () => {
    assert.equal(androidVersionCodeFor("1.0.10"), 101001099);
    assert.equal(androidVersionCodeFor("1.0.9"), 101000999);
    assert.equal(androidVersionCodeFor("1.0.10-rc.1"), 101001001);
    assert.throws(() => androidVersionCodeFor("not-a-version"), /Cannot derive/);
  });

  it("pins the tauri.conf.json contract the APK/AAB assertions rely on", () => {
    assert.equal(tauriConfig.identifier, "com.wordhunter.app");
    assert.equal(tauriConfig.version, "1.0.11-rc.1");
    assert.equal(androidVersionCodeFor(tauriConfig.version), 101001101);
    // The Android overlay overrides the package name (Word.Hunter.Pocket);
    // androidExpectations() must use it, not the desktop identifier.
    assert.equal(androidConfig.identifier, "com.wordhunter.pocket");
  });

  it("parses aapt2 dump badging and flags debuggable APKs", () => {
    assert.deepEqual(parseBadgingPackage(releaseBadging), {
      name: "com.wordhunter.pocket",
      versionCode: 101001099,
      versionName: "1.0.10",
    });
    assert.equal(parseBadgingPackage("not badging output"), null);
    assert.equal(isBadgingDebuggable(releaseBadging), false);
    assert.equal(isBadgingDebuggable(debugBadging), true);
  });

  it("parses aapt2 dump xmltree for the AAB manifest", () => {
    assert.deepEqual(parseXmlTreeManifest(releaseXmlTree), {
      versionCode: 101001099,
      versionName: "1.0.10",
      debuggable: false,
    });
    assert.equal(parseXmlTreeManifest(debugXmlTree).debuggable, true);
  });

  it("parses the text manifest from the AAB archive root", () => {
    const text = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.wordhunter.pocket" versionCode="101001101" versionName="1.0.11-rc.1">';
    assert.deepEqual(parseTextManifest(text), {
      versionCode: 101001101,
      versionName: "1.0.11-rc.1",
      debuggable: false,
    });
    assert.equal(
      parseTextManifest('<manifest android:debuggable="true"></manifest>').debuggable,
      true,
    );
    assert.deepEqual(parseTextManifest("<not-a-manifest/>"), {
      versionCode: null,
      versionName: null,
      debuggable: false,
    });
  });

  it("parses the binary AXML manifest from the AAB archive root", () => {
    // Minimal synthetic AXML: header + string pool ("1.0.11-rc.1") + resource
    // map + one start-element carrying versionCode/versionName/debuggable by
    // resource id.
    const versionName = "1.0.11-rc.1";
    // Pool: 20-byte header (count, styleCount, flags, stringsStart,
    // stylesStart) + 4-byte offset table + 2-byte length + utf16 chars.
    const pool = Buffer.alloc(20 + 4 + 2 + versionName.length * 2);
    pool.writeUInt32LE(1, 0); // stringCount
    pool.writeUInt32LE(0, 4); // styleCount
    pool.writeUInt32LE(0, 8); // flags
    pool.writeUInt32LE(32, 12); // stringsStart (8 chunk header + 20 pool header + 4 offsets)
    pool.writeUInt32LE(0, 16); // stylesStart
    pool.writeUInt32LE(0, 20); // offset[0] = 0
    pool.writeUInt16LE(versionName.length, 24);
    pool.write(versionName, 26, "utf16le");

    const resourceMap = Buffer.alloc(4 + 3 * 4);
    resourceMap.writeUInt32LE(0x0101021b, 0); // versionCode
    resourceMap.writeUInt32LE(0x0101021c, 4); // versionName
    resourceMap.writeUInt32LE(0x0101000f, 8); // debuggable

    // Start-element: header 8 + line 4 + comment 4 + ns 4 + name 4 +
    // attrStart 2 + attrSize 2 + attrCount 2 (=28) + attrs 3 x 20 -> 92.
    const element = Buffer.alloc(92);
    element.writeUInt16LE(0x0102, 0);
    element.writeUInt16LE(16, 2);
    element.writeUInt32LE(92, 4);
    element.writeUInt16LE(20, 24); // attributeStart
    element.writeUInt16LE(20, 26); // attributeSize
    element.writeUInt16LE(3, 28); // attrCount
    // attr 0 @32: versionCode (resource id 0) -> int 101001101
    element.writeUInt32LE(0, 36);
    element.writeUInt8(0x10, 44);
    element.writeUInt32LE(101001101, 48);
    // attr 1 @52: versionName (resource id 1) -> string pool index 0
    element.writeUInt32LE(1, 56);
    element.writeUInt8(0x03, 64);
    element.writeUInt32LE(0, 68);
    // attr 2 @72: debuggable (resource id 2) -> bool false
    element.writeUInt32LE(2, 76);
    element.writeUInt8(0x12, 84);
    element.writeUInt32LE(0, 88);

    const stringPoolChunk = Buffer.alloc(8 + pool.length);
    stringPoolChunk.writeUInt16LE(0x0001, 0);
    stringPoolChunk.writeUInt16LE(28, 2);
    stringPoolChunk.writeUInt32LE(8 + pool.length, 4);
    pool.copy(stringPoolChunk, 8);

    const resourceMapChunk = Buffer.alloc(8 + resourceMap.length);
    resourceMapChunk.writeUInt16LE(0x0180, 0);
    resourceMapChunk.writeUInt16LE(8, 2);
    resourceMapChunk.writeUInt32LE(8 + resourceMap.length, 4);
    resourceMap.copy(resourceMapChunk, 8);

    const axml = Buffer.concat([Buffer.from([0x03, 0, 0x08, 0, 24, 0, 0, 0]), stringPoolChunk, resourceMapChunk, element]);
    const parsed = parseAxmlManifest(axml);
    assert.equal(parsed.versionCode, 101001101);
    assert.equal(parsed.versionName, "1.0.11-rc.1");
    assert.equal(parsed.debuggable, false);
    assert.equal(parseAxmlManifest(Buffer.from("garbage")).axml, false);
  });

  it("parses the protobuf manifest from the AAB base/ directory", () => {
    // Minimal synthetic protobuf manifest (AAPT2 XmlNode schema):
    // Manifest{ XmlNode manifest=1 } -> XmlNode{ element=3 } ->
    // XmlElement{ name=1; attribute=5 x3 } ->
    // XmlAttribute{ resource_id=5; typed_value=6 } ->
    // TypedValue{ value=2 / string_value=3 }.
    const varint = (value) => {
      const out = [];
      let v = value >>> 0;
      while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v = v >>> 7;
      }
      out.push(v);
      return Buffer.from(out);
    };
    const ld = (field, payload) => {
      const tag = Buffer.from([(field << 3) | 2]);
      return Buffer.concat([tag, varint(payload.length), payload]);
    };
    const typed = (type, value, stringValue) => {
      const parts = [ld(1, Buffer.from([type]))];
      if (stringValue !== undefined) parts.push(ld(3, Buffer.from(stringValue, "utf8")));
      else parts.push(Buffer.concat([Buffer.from([2 << 3]), varint(value)])); // field 2, wire 0
      return Buffer.concat(parts);
    };
    const attribute = (resourceId, typedValue) =>
      Buffer.concat([ld(5, varint(resourceId)), ld(6, typedValue)]);
    const namedAttribute = (name, typedValue) =>
      Buffer.concat([ld(2, Buffer.from(name, "utf8")), ld(6, typedValue)]);
    const element = Buffer.concat([
      ld(1, Buffer.from("manifest", "utf8")),
      ld(5, attribute(0x0101021b, typed(0x10, 101001101))),
      ld(5, attribute(0x0101021c, typed(0x10, 0, "1.0.11-rc.1"))),
      ld(5, attribute(0x0101000f, typed(0x12, 0))),
    ]);
    const node = ld(5, element); // XmlNode.element = field 5 in the AAPT2 schema
    const manifest = ld(1, node);
    const parsed = parseProtoManifest(manifest);
    assert.equal(parsed.versionCode, 101001101);
    assert.equal(parsed.versionName, "1.0.11-rc.1");
    assert.equal(parsed.debuggable, false);
    // Real AABs store the manifest as a bare XmlNode (no Manifest wrapper).
    const bare = parseProtoManifest(node);
    assert.equal(bare.versionCode, 101001101);
    assert.equal(bare.versionName, "1.0.11-rc.1");
    assert.equal(bare.debuggable, false);
    // Some AABs omit resource ids and carry only the attribute name.
    const namedElement = Buffer.concat([
      ld(1, Buffer.from("manifest", "utf8")),
      ld(5, namedAttribute("versionCode", typed(0x10, 101001101))),
      ld(5, namedAttribute("versionName", typed(0x10, 0, "1.0.11-rc.1"))),
      ld(5, namedAttribute("debuggable", typed(0x12, 0))),
    ]);
    const named = parseProtoManifest(ld(5, namedElement));
    assert.equal(named.versionCode, 101001101);
    assert.equal(named.versionName, "1.0.11-rc.1");
    assert.equal(named.debuggable, false);
  });
});
