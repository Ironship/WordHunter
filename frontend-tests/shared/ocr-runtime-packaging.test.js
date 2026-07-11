import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectWindowsPortable,
  parseSimpleYaml,
} from "../../scripts/inspect-artifact.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

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

function powershellString(source, name) {
  const match = source.match(new RegExp(`^\\$${name}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  assert.ok(match, `PowerShell assignment not found: ${name}`);
  return match[1];
}

function createPeX64() {
  const value = Buffer.alloc(256);
  value.write("MZ", 0, "ascii");
  value.writeUInt32LE(128, 0x3c);
  value.writeUInt32LE(0x00004550, 128);
  value.writeUInt16LE(0x8664, 132);
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

function portableFixture() {
  const pe = createPeX64();
  return {
    "Word.Hunter.portable.exe": pe,
    "syncthing.exe": pe,
    "SYNCTHING-LICENSE.txt": "license",
    "SYNCTHING-AUTHORS.txt": "authors",
    LICENSE: "license",
    "THIRD-PARTY-NOTICES.md": "notices",
    "THIRD-PARTY-LICENSES.html": "licenses",
    "OCR-THIRD-PARTY-LICENSES.html": "licenses",
    "ocr-runtime/bin/wordhunter-paddleocr.exe": pe,
    "ocr-runtime/bin/pdfium.dll": "dll",
    "ocr-runtime/models/det.onnx": "model",
    "ocr-runtime/models/rec.onnx": "model",
    "ocr-runtime/models/cls.onnx": "model",
  };
}

describe("OCR runtime packaging", () => {
  it("defines an executable Windows recipe with pinned downloads and strict archive checks", () => {
    const runtimeScript = read("../../scripts/windows-runtime.ps1");
    const buildScript = read("../../scripts/build.bat");
    const ocrScript = read("../../src-tauri/ocr-runtime/prepare-runtime.ps1");
    const windowsConfig = JSON.parse(read("../../src-tauri/tauri.windows.conf.json"));

    const runtimeNames = runtimeScript
      .match(/\$WindowsRuntimeDllNames\s*=\s*@\(([\s\S]*?)\)/)[1]
      .match(/"([^"]+\.dll)"/g)
      .map((name) => name.slice(1, -1).toLowerCase());
    for (const name of [
      "libstdc++-6.dll",
      "libgcc_s_seh-1.dll",
      "libwinpthread-1.dll",
      "vcruntime140.dll",
      "msvcp140.dll",
    ]) {
      assert.ok(runtimeNames.includes(name), `runtime dependency allowlist is missing ${name}`);
    }

    assert.equal(powershellString(buildScript, "WindowsRustTarget"), "x86_64-pc-windows-msvc");
    assert.equal(powershellString(buildScript, "SyncthingVersion"), "2.1.0");
    assert.match(powershellString(buildScript, "SyncthingSha256"), /^[0-9A-F]{64}$/);
    assert.match(powershellString(ocrScript, "PaddleModelsSha256"), /^[0-9A-F]{64}$/);
    assert.match(powershellString(ocrScript, "PdfiumSha256"), /^[0-9A-F]{64}$/);
    assert.doesNotMatch(ocrScript, /releases\/latest\/download/);

    const downloadSyncthing = powershellFunction(buildScript, "Download-Syncthing");
    assert.match(downloadSyncthing, /Download-File \$url \$zip \$SyncthingSha256/);
    assert.match(downloadSyncthing, /"LICENSE\.txt"\) -Destination \$SyncthingLicense/);
    assert.match(downloadSyncthing, /"AUTHORS\.txt"\) -Destination \$SyncthingAuthors/);
    const portable = powershellFunction(buildScript, "Build-Portable");
    const installer = powershellFunction(buildScript, "Build-Installer");
    assert.match(portable, /--target", \$WindowsRustTarget/);
    assert.match(portable, /Copy-AppRuntimeDlls \$RustExe \$PortableDir/);
    assert.match(installer, /New-WindowsRuntimeTauriConfig/);
    assert.match(installer, /--config/);
    for (const functionName of ["Assert-ArchiveContainsRuntimeDlls", "Assert-ArchiveContainsFile"]) {
      const body = powershellFunction(buildScript, functionName);
      assert.match(body, /Refusing to produce an unvalidated release artifact/);
      assert.doesNotMatch(body, /skipping archive/i);
      assert.match(body, /\$LASTEXITCODE -ne 0/);
    }

    const resources = windowsConfig.bundle.resources;
    assert.equal(resources["syncthing/syncthing.exe"], "syncthing.exe");
    assert.equal(resources["syncthing/SYNCTHING-LICENSE.txt"], "SYNCTHING-LICENSE.txt");
    assert.equal(resources["../THIRD-PARTY-LICENSES.html"], "THIRD-PARTY-LICENSES.html");
    assert.equal(resources["../OCR-THIRD-PARTY-LICENSES.html"], "OCR-THIRD-PARTY-LICENSES.html");
  });

  it("parses the Flatpak recipe and enforces pins, licenses, and x86_64 policy", () => {
    const manifest = parseSimpleYaml(read("../../com.wordhunter.app.yml"));
    const module = manifest.modules.find((candidate) => candidate.name === "word-hunter");
    assert.ok(module);
    assert.deepEqual(module["only-arches"], ["x86_64"]);
    assert.equal(module["build-options"].env.CARGO_NET_OFFLINE, "true");
    assert.equal(module["build-options"].env.CTRANSLATE2_RELEASE, "4.6.0");
    assert.equal(module["build-options"].env.ORT_LIB_LOCATION, "/run/build/word-hunter/src-tauri/target/flatpak-onnxruntime");
    assert.ok(!manifest["finish-args"].includes("--env=GTK_USE_PORTAL=1"));
    assert.ok(manifest["finish-args"].includes("--filesystem=xdg-config/gtk-3.0:ro"));
    assert.ok(manifest["finish-args"].includes("--filesystem=xdg-config/kdeglobals:ro"));

    const commands = module["build-commands"];
    for (const expected of [
      "cargo --offline build --release --manifest-path src-tauri/Cargo.toml",
      "cargo --offline build --release --manifest-path src-tauri/ocr-runner/Cargo.toml",
    ]) {
      assert.ok(commands.includes(expected));
    }
    assert.ok(commands.some((command) => command.includes("/app/bin/ocr-runtime/bin/wordhunter-paddleocr")));
    assert.ok(commands.some((command) => command.includes("/app/lib/libwebgpu_dawn.so")));
    assert.ok(commands.some((command) => command.includes("/app/bin/ocr-runtime/bin/libpdfium.so")));
    assert.ok(commands.some((command) => command.includes("SYNCTHING-LICENSE.txt")));
    assert.ok(commands.some((command) => command.includes("THIRD-PARTY-LICENSES.html OCR-THIRD-PARTY-LICENSES.html")));

    const archives = module.sources.filter((source) => source && source.type === "archive");
    assert.ok(archives.length >= 4);
    for (const source of archives) {
      assert.match(source.url, /^https:\/\//);
      assert.match(source.sha256, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(source.url, /\/latest\//);
    }
    assert.ok(archives.some((source) => source.url.includes("x86_64-unknown-linux-gnu")));
    assert.ok(archives.some((source) => source.url.includes("x86_64-unknown-linux-gnu+wgpu.tgz")));
    assert.ok(archives.some((source) => source.url.includes("pdfium-linux-x64")));
    assert.ok(archives.some((source) => source.url.includes("syncthing-linux-amd64-v2.1.0")));

    const ocrCargo = read("../../src-tauri/ocr-runner/Cargo.toml");
    assert.match(ocrCargo, /cfg\(target_os = "linux"\)[\s\S]*features = \["webgpu"\]/);

    const buildCommands = read("../../scripts/build-flatpak.sh")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    assert.ok(buildCommands.includes('jobs="${FLATPAK_JOBS:-2}"'));
    assert.ok(buildCommands.includes('node "$artifact_inspector" flatpak "$bundle"'));
  });

  it("validates archive contents and rejects a fixture with license drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "wordhunter-portable-test-"));
    try {
      const valid = join(directory, "valid.zip");
      writeStoredZip(valid, portableFixture());
      assert.doesNotThrow(() => inspectWindowsPortable(valid));

      const invalid = join(directory, "invalid.zip");
      const files = portableFixture();
      delete files["OCR-THIRD-PARTY-LICENSES.html"];
      writeStoredZip(invalid, files);
      assert.throws(() => inspectWindowsPortable(invalid), /OCR-THIRD-PARTY-LICENSES\.html/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
