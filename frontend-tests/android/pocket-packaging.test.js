import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAndroid } from "../../scripts/inspect-artifact.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function parseXml(source) {
  const document = { name: "#document", attributes: {}, children: [] };
  const stack = [document];
  const cleaned = source.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const match of cleaned.matchAll(/<([^>]+)>/g)) {
    const token = match[1].trim();
    if (!token || token.startsWith("!")) continue;
    if (token.startsWith("/")) {
      const name = token.slice(1).trim();
      assert.equal(stack.at(-1).name, name, `mismatched XML closing tag: ${name}`);
      stack.pop();
      continue;
    }
    const selfClosing = token.endsWith("/");
    const opening = selfClosing ? token.slice(0, -1).trimEnd() : token;
    const nameMatch = opening.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/);
    assert.ok(nameMatch, `invalid XML element: ${token}`);
    const node = { name: nameMatch[1], attributes: {}, children: [] };
    let attributes = nameMatch[2];
    attributes = attributes.replace(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g, (_, name, value) => {
      node.attributes[name] = value;
      return "";
    });
    assert.equal(attributes.trim(), "", `invalid XML attributes on ${node.name}`);
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  assert.equal(stack.length, 1, `unclosed XML element: ${stack.at(-1).name}`);
  assert.equal(document.children.length, 1, "XML must have one document element");
  return document.children[0];
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function powershellFunction(source, name) {
  const pattern = new RegExp(`^function ${name}\\b`, "m");
  const match = pattern.exec(source);
  assert.ok(match, `PowerShell function not found: ${name}`);
  const remainder = source.slice(match.index);
  const next = remainder.slice(1).search(/^function [A-Za-z0-9-]+\b/m);
  return (next < 0 ? remainder : remainder.slice(0, next + 1))
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function createArm64Elf() {
  const value = Buffer.alloc(64);
  value.set([0x7f, 0x45, 0x4c, 0x46], 0);
  value[4] = 2;
  value[5] = 1;
  value.writeUInt16LE(183, 18);
  return value;
}

function writeStoredZip(path, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, rawValue] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const value = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, value);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + value.length;
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...localParts, ...centralParts, end]));
}

function androidFixture(abi = "arm64-v8a") {
  return {
    "base/manifest/AndroidManifest.xml": "binary manifest",
    "base/dex/classes.dex": "dex",
    [`base/lib/${abi}/libword_hunter.so`]: createArm64Elf(),
    "base/root/LICENSE": "license",
    "base/root/THIRD-PARTY-NOTICES.md": "notices",
    "base/root/THIRD-PARTY-LICENSES.html": "licenses",
    "base/root/OCR-THIRD-PARTY-LICENSES.html": "licenses",
  };
}

describe("Android Pocket packaging", () => {
  it("parses Android JSON and XML policy instead of matching serialized text", () => {
    const baseConfig = JSON.parse(read("../../src-tauri/tauri.conf.json"));
    const androidConfig = JSON.parse(read("../../src-tauri/tauri.android.conf.json"));
    const manifest = parseXml(read("../../src-tauri/platforms/android/AndroidManifest.xml"));

    assert.equal(androidConfig.identifier, "com.wordhunter.pocket");
    assert.equal(androidConfig.bundle.android.minSdkVersion, 24);
    assert.equal(androidConfig.app.windows.length, 1);
    assert.equal(androidConfig.app.windows[0].create, false);
    assert.equal(androidConfig.app.windows[0].url, "http://127.0.0.1:38619/index.html");
    assert.equal(JSON.stringify(androidConfig).includes("ocr-runtime"), false);
    assert.equal(JSON.stringify(baseConfig).includes("ocr-runtime"), false);
    for (const resource of [
      "../LICENSE",
      "../THIRD-PARTY-NOTICES.md",
      "../THIRD-PARTY-LICENSES.html",
      "../OCR-THIRD-PARTY-LICENSES.html",
    ]) {
      assert.ok(Object.hasOwn(baseConfig.bundle.resources, resource));
    }

    assert.equal(manifest.name, "manifest");
    const elements = descendants(manifest);
    assert.deepEqual(
      elements.filter((node) => node.name === "uses-permission").map((node) => node.attributes["android:name"]),
      ["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"],
    );
    assert.equal(elements.some((node) => /LEANBACK|FileProvider|file_paths/.test(JSON.stringify(node))), false);
    const launcher = elements.find(
      (node) => node.name === "category" && node.attributes["android:name"] === "android.intent.category.LAUNCHER",
    );
    assert.ok(launcher, "Android manifest has no launcher activity");
  });

  it("derives a bounded monotonic version code and patches the generated project", () => {
    const baseConfig = JSON.parse(read("../../src-tauri/tauri.conf.json"));
    const build = read("../../scripts/build.bat");
    const parts = baseConfig.version.match(/^(\d+)\.(\d+)\.(\d+)(?:(?:-rc\.(\d+))|(?:\+(\d+)))?$/);
    assert.ok(parts, "Tauri version must be stable, an RC, or a +1 hotfix SemVer");
    const [, majorText, minorText, patchText, rcText, hotfixText] = parts;
    const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
    assert.ok(minor < 1_000 && patch < 1_000);
    const baseCode = (major * 1_000_000) + (minor * 1_000) + patch;
    const releaseOrdinal = rcText ? Number(rcText) : (hotfixText ? 100 : 99);
    assert.ok(releaseOrdinal >= 1 && releaseOrdinal <= 100);
    if (hotfixText) assert.equal(hotfixText, "1");
    const versionCode = (baseCode * 100) + releaseOrdinal;
    assert.ok(Number.isSafeInteger(versionCode));
    assert.ok(versionCode > 0 && versionCode <= 2_100_000_000);
    assert.ok(versionCode < ((major + 1) * 100_000_000));

    const versionRecipe = powershellFunction(build, "Get-AndroidVersionInfo");
    assert.match(versionRecipe, /\$minor -gt 999 -or \$patch -gt 999/);
    assert.match(versionRecipe, /\(\$major \* 1000000\) \+ \(\$minor \* 1000\) \+ \$patch/);
    assert.match(versionRecipe, /\$code = \(\$baseCode \* 100\) \+ \$releaseOrdinal/);
    assert.match(versionRecipe, /release-candidate ordinal must be between 1 and 98/);
    assert.match(versionRecipe, /four-part hotfix version must end in \+1/);
    assert.match(versionRecipe, /\$releaseOrdinal = 100/);
    assert.match(versionRecipe, /Name = \$version\.Replace\('\+', '\.'\)/);
    assert.match(versionRecipe, /\$code -le 0 -or \$code -gt 2100000000/);
    const prepare = powershellFunction(build, "Prepare-AndroidProject");
    assert.match(prepare, /Copy-Item -LiteralPath \$activitySource -Destination \$activityTarget/);
    assert.match(prepare, /Copy-Item -LiteralPath \$manifestSource -Destination \$manifestTarget/);
    assert.match(prepare, /Set-AndroidGradleVersion/);
    assert.match(prepare, /androidx\.documentfile:documentfile:1\.0\.1/);
    const release = powershellFunction(build, "Build-AndroidReleaseAab");
    assert.match(release, /"android", "build", "--aab", "--target", \$Target/);
    assert.match(powershellFunction(build, "Copy-OrSignAndroidAab"), /jarsigner\.exe/);
  });

  it("validates AAB file lists and rejects the wrong native architecture", () => {
    const directory = mkdtempSync(join(tmpdir(), "wordhunter-android-test-"));
    try {
      const valid = join(directory, "valid.aab");
      writeStoredZip(valid, androidFixture());
      assert.doesNotThrow(() => inspectAndroid(valid, "arm64-v8a"));

      const invalid = join(directory, "wrong-abi.aab");
      writeStoredZip(invalid, androidFixture("x86_64"));
      assert.throws(() => inspectAndroid(invalid, "arm64-v8a"), /expected only arm64-v8a/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
