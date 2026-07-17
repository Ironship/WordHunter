#!/usr/bin/env node

import { inflateRawSync } from "node:zlib";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function fail(message) {
  throw new Error(message);
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

// This intentionally supports the conservative YAML subset used by the two
// repository manifests. Unknown YAML features fail instead of being guessed.
export function parseSimpleYaml(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const tokens = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^\s*(?:#.*)?$/.test(raw)) continue;
    const indent = raw.match(/^ */)[0].length;
    if (raw.slice(0, indent).includes("\t")) fail(`YAML line ${index + 1} uses a tab`);
    tokens.push({ indent, text: raw.slice(indent), raw, line: index + 1 });
  }

  const splitMapping = (text, line) => {
    const match = text.match(/^([^:#][^:]*):(?:\s+(.*))?$/);
    if (!match) fail(`Unsupported YAML mapping on line ${line}: ${text}`);
    return [match[1].trim(), match[2] ?? ""];
  };

  const parseBlock = (start, indent) => {
    if (start >= tokens.length || tokens[start].indent < indent) return [null, start];
    if (tokens[start].indent !== indent) {
      fail(`Unexpected YAML indentation on line ${tokens[start].line}`);
    }
    const isArray = tokens[start].text === "-" || tokens[start].text.startsWith("- ");
    const result = isArray ? [] : {};
    let cursor = start;

    const parseValue = (rawValue, token, nextCursor) => {
      if (rawValue === "|" || rawValue === ">") {
        const block = [];
        let blockCursor = nextCursor;
        while (blockCursor < tokens.length && tokens[blockCursor].indent > token.indent) {
          block.push(tokens[blockCursor].raw.slice(token.indent + 2));
          blockCursor += 1;
        }
        return [rawValue === ">" ? block.join(" ") : block.join("\n"), blockCursor];
      }
      if (rawValue !== "") return [parseScalar(rawValue), nextCursor];
      if (nextCursor < tokens.length && tokens[nextCursor].indent > token.indent) {
        return parseBlock(nextCursor, tokens[nextCursor].indent);
      }
      return [null, nextCursor];
    };

    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.indent < indent) break;
      if (token.indent !== indent) fail(`Unexpected YAML indentation on line ${token.line}`);

      if (isArray) {
        if (!(token.text === "-" || token.text.startsWith("- "))) {
          fail(`Expected a YAML sequence item on line ${token.line}`);
        }
        const itemText = token.text.slice(1).trimStart();
        cursor += 1;
        if (itemText === "") {
          const [value, next] = parseValue("", token, cursor);
          result.push(value);
          cursor = next;
          continue;
        }
        if (/^[^:#][^:]*:(?:\s|$)/.test(itemText)) {
          const [key, rawValue] = splitMapping(itemText, token.line);
          const item = {};
          let value;
          [value, cursor] = parseValue(rawValue, token, cursor);
          item[key] = value;
          if (cursor < tokens.length && tokens[cursor].indent > indent) {
            const childIndent = tokens[cursor].indent;
            const [extra, next] = parseBlock(cursor, childIndent);
            if (Array.isArray(extra) || extra === null || typeof extra !== "object") {
              fail(`Expected a YAML mapping on line ${tokens[cursor].line}`);
            }
            Object.assign(item, extra);
            cursor = next;
          }
          result.push(item);
          continue;
        }
        result.push(parseScalar(itemText));
        continue;
      }

      if (token.text === "-" || token.text.startsWith("- ")) {
        fail(`Expected a YAML mapping on line ${token.line}`);
      }
      const [key, rawValue] = splitMapping(token.text, token.line);
      cursor += 1;
      let value;
      [value, cursor] = parseValue(rawValue, token, cursor);
      result[key] = value;
    }
    return [result, cursor];
  };

  if (tokens.length === 0) return {};
  const [document, cursor] = parseBlock(0, tokens[0].indent);
  if (cursor !== tokens.length) fail(`YAML parsing stopped before line ${tokens[cursor].line}`);
  return document;
}

function normalizeArchivePath(name) {
  const replaced = name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    replaced.startsWith("/") ||
    /^[A-Za-z]:\//.test(replaced) ||
    replaced.split("/").includes("..")
  ) {
    fail(`Archive contains unsafe path: ${name}`);
  }
  return replaced;
}

export function readZipArchive(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 22) fail(`${path} is not a ZIP archive`);
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail(`${path} has no ZIP end-of-central-directory record`);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    fail(`${path} uses unsupported ZIP64 metadata`);
  }
  if (count === 0) fail(`${path} is an empty ZIP archive`);

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail(`${path} has a malformed ZIP central directory`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const name = normalizeArchivePath(rawName);
    if (name && entries.has(name.toLowerCase())) fail(`${path} contains duplicate entry: ${name}`);
    if (name) {
      entries.set(name.toLowerCase(), {
        name,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { path, buffer, entries };
}

function zipEntryBytes(archive, entry) {
  const { buffer, path } = archive;
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    fail(`${path} has a malformed local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let value;
  if (entry.method === 0) value = compressed;
  else if (entry.method === 8) value = inflateRawSync(compressed);
  else fail(`${path} uses unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (value.length !== entry.uncompressedSize) fail(`${path} has a truncated entry: ${entry.name}`);
  return value;
}

function namesOf(archive) {
  return [...archive.entries.values()].map((entry) => entry.name);
}

function requireEntry(archive, expected) {
  const entry = archive.entries.get(expected.toLowerCase());
  if (!entry) fail(`${archive.path} is missing required entry: ${expected}`);
  return entry;
}

function requireSuffix(names, suffix) {
  const lower = suffix.toLowerCase();
  const found = names.find((name) => name.toLowerCase() === lower || name.toLowerCase().endsWith(`/${lower}`));
  if (!found) fail(`Artifact is missing required file: ${suffix}`);
  return found;
}

function assertPeX64(bytes, description) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    fail(`${description} is not a PE executable`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    fail(`${description} has no PE header`);
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) fail(`${description} is not x86_64`);
}

function assertElfMachine(bytes, machine, description) {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    fail(`${description} is not an ELF binary`);
  }
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine) {
    fail(`${description} has the wrong machine architecture`);
  }
}

const legalFiles = [
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "THIRD-PARTY-LICENSES.html",
  "OCR-THIRD-PARTY-LICENSES.html",
];

export function inspectAndroid(path, abi) {
  const archive = readZipArchive(path);
  const names = namesOf(archive);
  const isAab = path.toLowerCase().endsWith(".aab");
  const manifest = isAab ? "base/manifest/AndroidManifest.xml" : "AndroidManifest.xml";
  requireEntry(archive, manifest);
  if (!names.some((name) => (isAab ? /^base\/dex\/classes.*\.dex$/ : /^classes.*\.dex$/).test(name))) {
    fail(`${path} contains no compiled Android classes`);
  }

  const nativePattern = isAab ? /^base\/lib\/([^/]+)\/[^/]+\.so$/ : /^lib\/([^/]+)\/[^/]+\.so$/;
  const nativeEntries = [...archive.entries.values()].filter((entry) => nativePattern.test(entry.name));
  if (nativeEntries.length === 0) fail(`${path} contains no native Android libraries`);
  const packagedAbis = new Set(nativeEntries.map((entry) => entry.name.match(nativePattern)[1]));
  if (packagedAbis.size !== 1 || !packagedAbis.has(abi)) {
    fail(`${path} packages ${[...packagedAbis].join(", ") || "no ABI"}; expected only ${abi}`);
  }
  const machine = abi === "arm64-v8a" ? 183 : abi === "x86_64" ? 62 : null;
  if (machine === null) fail(`Unsupported expected Android ABI: ${abi}`);
  for (const entry of nativeEntries) {
    assertElfMachine(zipEntryBytes(archive, entry), machine, `${path}:${entry.name}`);
  }
  if (names.some((name) => /ocr-runtime|wordhunter-paddleocr|pdfium/i.test(name))) {
    fail(`${path} unexpectedly contains the desktop OCR runtime`);
  }
  for (const legalFile of legalFiles) requireSuffix(names, legalFile);
  console.log(`Validated ${isAab ? "AAB" : "APK"}: ${path} (${abi}, ${names.length} entries)`);
}

export function inspectWindowsPortable(path, requiredDlls = []) {
  const archive = readZipArchive(path);
  const names = namesOf(archive);
  const required = [
    "Word.Hunter.portable.exe",
    "syncthing.exe",
    "SYNCTHING-LICENSE.txt",
    "SYNCTHING-AUTHORS.txt",
    ...legalFiles,
    "ocr-runtime/bin/wordhunter-paddleocr.exe",
    "ocr-runtime/bin/pdfium.dll",
    ...requiredDlls,
  ];
  for (const name of required) requireEntry(archive, name);
  const models = names.filter((name) => /^ocr-runtime\/models\/[^/]+\.onnx$/i.test(name));
  if (models.length < 3) fail(`${path} must contain all three PaddleOCR ONNX models`);
  for (const executable of [
    "Word.Hunter.portable.exe",
    "syncthing.exe",
    "ocr-runtime/bin/wordhunter-paddleocr.exe",
  ]) {
    assertPeX64(zipEntryBytes(archive, requireEntry(archive, executable)), `${path}:${executable}`);
  }
  console.log(`Validated Windows portable ZIP: ${path} (${names.length} entries)`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.binary ? null : "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`Could not execute ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = options.binary ? result.stderr.toString("utf8") : result.stderr;
    fail(`${command} ${args.join(" ")} failed (${result.status}): ${stderr.trim()}`);
  }
  return result.stdout;
}

function findSevenZip() {
  for (const command of ["7z", "7z.exe", "7zz"]) {
    const result = spawnSync(command, ["i"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return command;
  }
  fail("7-Zip is required to inspect an NSIS installer; refusing to skip archive validation");
}

function walkFiles(root, current = root) {
  const files = [];
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, item.name);
    if (item.isDirectory()) files.push(...walkFiles(root, path));
    else if (item.isFile()) files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files;
}

function localArtifactPath(root, name) {
  return join(root, ...name.split("/"));
}

function assertExecutable(root, name, description) {
  // Windows cannot represent POSIX executable bits in a temporary fixture.
  // Real AppImage and DEB inspection only runs on Linux.
  if (process.platform === "win32") return;
  if ((statSync(localArtifactPath(root, name)).mode & 0o111) === 0) {
    fail(`${description}:${name} is not executable`);
  }
}

function requireRootSymlink(root, name, targetSuffix, description) {
  const path = join(root, name);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${description} is missing AppImage root entry: ${name}`);
  }
  if (!metadata.isSymbolicLink()) fail(`${description}:${name} must be a symbolic link`);
  const target = readlinkSync(path).replaceAll("\\", "/");
  if (!target.endsWith(targetSuffix)) {
    fail(`${description}:${name} points to ${target}; expected */${targetSuffix}`);
  }
  try {
    if (!statSync(path).isFile()) fail(`${description}:${name} does not resolve to a file`);
  } catch {
    fail(`${description}:${name} is a broken symbolic link`);
  }
}

function requireLinuxResource(names, suffix) {
  const lower = suffix.toLowerCase();
  const found = names.find((name) => {
    const normalized = name.toLowerCase();
    return (
      normalized.startsWith("usr/lib/") &&
      (normalized === lower || normalized.endsWith(`/${lower}`))
    );
  });
  if (!found) fail(`Artifact is missing required Linux resource: usr/lib/**/${suffix}`);
  return found;
}

export function inspectLinuxTree(root, description = root, options = {}) {
  const format = options.format ?? "appimage";
  if (!new Set(["appimage", "deb"]).has(format)) fail(`Unknown Linux package tree format: ${format}`);
  const names = walkFiles(root);
  const main = requireSuffix(names, "usr/bin/word-hunter-rustified");
  const ocrRunner = requireLinuxResource(names, "ocr-runtime/bin/wordhunter-paddleocr");
  const pdfium = requireLinuxResource(names, "ocr-runtime/bin/libpdfium.so");
  const webGpuDawn = requireLinuxResource(names, "ocr-runtime/bin/libwebgpu_dawn.so");
  let syncthing = null;
  const mediaRuntime = [];
  if (format === "appimage") {
    syncthing = requireSuffix(names, "usr/bin/syncthing");
    requireSuffix(names, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh");
    for (const plugin of [
      "usr/lib/gstreamer-1.0/libgstcoreelements.so",
      "usr/lib/gstreamer-1.0/libgstplayback.so",
      "usr/lib/gstreamer-1.0/libgstautodetect.so",
    ]) {
      mediaRuntime.push(requireSuffix(names, plugin));
    }
  } else if (names.some((name) => /(?:^|\/)syncthing$/i.test(name))) {
    fail(`${description} must use the Debian syncthing dependency instead of bundling the executable`);
  }

  const models = names.filter((name) => (
    name.toLowerCase().startsWith("usr/lib/") &&
    /\/ocr-runtime\/models\/[^/]+\.onnx$/i.test(name)
  ));
  if (models.length < 3) fail(`${description} must contain all three PaddleOCR ONNX models`);

  for (const legalFile of [
    ...legalFiles,
    "SYNCTHING-LICENSE.txt",
    "SYNCTHING-AUTHORS.txt",
  ]) {
    requireSuffix(names, legalFile);
  }

  const desktopEntries = names.filter((name) => /^usr\/share\/applications\/[^/]+\.desktop$/i.test(name));
  const desktopEntry = "usr/share/applications/Word Hunter.desktop";
  if (desktopEntries.length !== 1 || desktopEntries[0] !== desktopEntry) {
    fail(`${description} must contain exactly the canonical ${desktopEntry} launcher`);
  }
  const appStream = "usr/share/metainfo/com.wordhunter.app.metainfo.xml";
  if (!names.includes(appStream)) fail(`${description} is missing ${appStream}`);
  const icons = names.filter((name) => (
    /^usr\/share\/icons\/hicolor\/[^/]+\/apps\/(?:com\.wordhunter\.app|word[-_. ]?hunter)[^/]*\.png$/i
      .test(name)
  ));
  if (icons.length === 0) fail(`${description} contains no Word Hunter hicolor application icon`);

  const desktopSource = readFileSync(localArtifactPath(root, desktopEntry), "utf8");
  for (const expected of [
    /^\[Desktop Entry\]$/m,
    /^Type=Application$/m,
    /^Name=Word Hunter$/m,
    /^Exec=word-hunter-rustified$/m,
    /^Icon=com\.wordhunter\.app$/m,
    /^Terminal=false$/m,
    /^Categories=Education;Languages;$/m,
    /^StartupWMClass=com\.wordhunter\.app$/m,
  ]) {
    if (!expected.test(desktopSource)) {
      fail(`${description}:${desktopEntry} is missing required desktop metadata: ${expected}`);
    }
  }
  const appStreamSource = readFileSync(localArtifactPath(root, appStream), "utf8");
  if (
    !/<component(?:\s|>)/.test(appStreamSource) ||
    !/<id>com\.wordhunter\.app<\/id>/.test(appStreamSource) ||
    !/<launchable type="desktop-id">Word Hunter\.desktop<\/launchable>/.test(appStreamSource)
  ) {
    fail(`${description}:${appStream} is not Word Hunter AppStream metadata`);
  }

  for (const name of [main, ocrRunner, pdfium, webGpuDawn, syncthing, ...mediaRuntime].filter(Boolean)) {
    assertElfMachine(
      readFileSync(localArtifactPath(root, name)),
      62,
      `${description}:${name}`,
    );
  }
  assertExecutable(root, main, description);
  assertExecutable(root, ocrRunner, description);
  if (syncthing) assertExecutable(root, syncthing, description);
  if (format === "deb") {
    requireSuffix(names, "usr/share/doc/word-hunter/copyright");
    requireSuffix(names, "usr/share/doc/word-hunter/changelog.gz");
    const lintianOverrides = requireSuffix(names, "usr/share/lintian/overrides/word-hunter");
    const overrideSource = readFileSync(localArtifactPath(root, lintianOverrides), "utf8");
    for (const embeddedLibrary of ["freetype", "lcms2", "openjpeg"]) {
      const pattern = new RegExp(
        `^word-hunter: embedded-library ${embeddedLibrary} usr/lib/\\*/ocr-runtime/bin/libpdfium\\.so$`,
        "m",
      );
      if (!pattern.test(overrideSource)) {
        fail(`${description} is missing the scoped PDFium ${embeddedLibrary} Lintian override`);
      }
    }
  }
  return names;
}

export function inspectLinuxAppImage(path) {
  const absolutePath = resolve(path);
  assertElfMachine(readFileSync(absolutePath), 62, absolutePath);
  const temp = mkdtempSync(join(tmpdir(), "wordhunter-appimage-"));
  const originalMode = statSync(absolutePath).mode;
  try {
    // GitHub artifact downloads do not preserve executable bits. The AppImage
    // runtime's extraction mode unpacks the SquashFS without launching the app.
    chmodSync(absolutePath, originalMode | 0o100);
    run(absolutePath, ["--appimage-extract"], { cwd: temp });
    const root = join(temp, "squashfs-root");
    if (!statSync(root).isDirectory()) fail(`${absolutePath} did not extract an AppImage filesystem`);
    const appRun = join(root, "AppRun");
    if (!lstatSync(appRun).isFile()) fail(`${absolutePath} is missing its AppRun executable`);
    if ((statSync(appRun).mode & 0o111) === 0) fail(`${absolutePath}:AppRun is not executable`);
    requireRootSymlink(root, ".DirIcon", "Word Hunter.png", absolutePath);
    requireRootSymlink(
      root,
      "Word Hunter.desktop",
      "usr/share/applications/Word Hunter.desktop",
      absolutePath,
    );
    const names = inspectLinuxTree(root, absolutePath, { format: "appimage" });
    console.log(`Validated Linux AppImage: ${absolutePath} (${names.length} files, x86_64)`);
  } finally {
    chmodSync(absolutePath, originalMode);
    rmSync(temp, { recursive: true, force: true });
  }
}

export function inspectLinuxDeb(path) {
  const packageName = run("dpkg-deb", ["--field", path, "Package"]).trim();
  if (packageName !== "word-hunter") fail(`${path} has Debian package name ${packageName || "unknown"}; expected word-hunter`);
  const version = run("dpkg-deb", ["--field", path, "Version"]).trim();
  const filename = basename(path).match(/^word-hunter_(.+)_amd64\.deb$/);
  if (!filename || version !== filename[1]) {
    fail(`${path} has Debian version ${version || "unknown"} inconsistent with its release filename`);
  }
  const architecture = run("dpkg-deb", ["--field", path, "Architecture"]).trim();
  if (architecture !== "amd64") fail(`${path} has Debian architecture ${architecture || "unknown"}; expected amd64`);
  const maintainer = run("dpkg-deb", ["--field", path, "Maintainer"]).trim();
  if (!/^Ironship <[^<>\s]+@users\.noreply\.github\.com>$/.test(maintainer)) {
    fail(`${path} has invalid Debian Maintainer metadata: ${maintainer || "missing"}`);
  }
  const dependencies = run("dpkg-deb", ["--field", path, "Depends"]).trim();
  for (const dependency of [
    "libc6",
    "libgtk-3-0",
    "libwebkit2gtk-4.1-0",
    "libxdo3",
    "gstreamer1.0-plugins-base",
    "gstreamer1.0-plugins-good",
    "syncthing",
  ]) {
    const pattern = new RegExp(`(?:^|,\\s*)${dependency.replaceAll(".", "\\.")}(?:\\s*\\([^)]*\\))?(?:,|$)`);
    if (!pattern.test(dependencies)) fail(`${path} is missing Debian dependency: ${dependency}`);
  }
  const temp = mkdtempSync(join(tmpdir(), "wordhunter-deb-"));
  try {
    run("dpkg-deb", ["--extract", path, temp]);
    const names = inspectLinuxTree(temp, path, { format: "deb" });
    console.log(`Validated Linux DEB: ${path} (${names.length} files, amd64)`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function inspectWindowsNsis(path, requiredDlls = []) {
  const sevenZip = findSevenZip();
  const extractDir = mkdtempSync(join(tmpdir(), "wordhunter-nsis-"));
  try {
    run(sevenZip, ["x", "-y", `-o${extractDir}`, path]);
    const names = walkFiles(extractDir);
    for (const name of [
      "syncthing.exe",
      "SYNCTHING-LICENSE.txt",
      "SYNCTHING-AUTHORS.txt",
      ...legalFiles,
      "wordhunter-paddleocr.exe",
      "pdfium.dll",
      ...requiredDlls,
    ]) {
      requireSuffix(names, name);
    }
    if (names.filter((name) => /ocr-runtime\/models\/[^/]+\.onnx$/i.test(name)).length < 3) {
      fail(`${path} must contain all three PaddleOCR ONNX models`);
    }
    const executableNames = names.filter((name) => /\.exe$/i.test(name));
    const main = executableNames.find(
      (name) => !/syncthing|wordhunter-paddleocr|uninstall|uninst/i.test(basename(name)),
    );
    if (!main) fail(`${path} contains no installed application executable`);
    for (const name of [
      main,
      requireSuffix(names, "syncthing.exe"),
      requireSuffix(names, "wordhunter-paddleocr.exe"),
    ]) {
      assertPeX64(readFileSync(join(extractDir, name)), `${path}:${name}`);
    }
    console.log(`Validated Windows NSIS installer: ${path} (${names.length} extracted files)`);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function inspectFlatpak(path) {
  const temp = mkdtempSync(join(tmpdir(), "wordhunter-flatpak-"));
  const repo = join(temp, "repo");
  try {
    run("ostree", ["init", `--repo=${repo}`, "--mode=archive-z2"]);
    run("flatpak", ["build-import-bundle", "--no-update-summary", repo, path]);
    const refs = run("ostree", ["refs", `--repo=${repo}`]).trim().split(/\r?\n/).filter(Boolean);
    const ref = "app/com.wordhunter.app/x86_64/stable";
    if (!refs.includes(ref)) fail(`${path} is missing Flatpak ref ${ref}`);
    const otherArchitectures = refs.filter(
      (candidate) => candidate.startsWith("app/com.wordhunter.app/") && candidate !== ref,
    );
    if (otherArchitectures.length > 0) fail(`${path} contains unexpected refs: ${otherArchitectures.join(", ")}`);

    const listing = run("ostree", ["ls", `--repo=${repo}`, "-R", ref, "/files"]);
    const names = listing
      .split(/\r?\n/)
      .map((line) => line.match(/\s(\/files\/\S+)$/)?.[1])
      .filter(Boolean);
    const required = [
      "/files/bin/word-hunter-rustified",
      "/files/bin/ocr-runtime/bin/wordhunter-paddleocr",
      "/files/bin/ocr-runtime/bin/libpdfium.so",
      "/files/lib/libwebgpu_dawn.so",
      "/files/bin/syncthing",
      "/files/share/licenses/com.wordhunter.app/LICENSE",
      "/files/share/doc/word-hunter/SYNCTHING-LICENSE.txt",
      "/files/share/doc/word-hunter/SYNCTHING-AUTHORS.txt",
      "/files/share/doc/word-hunter/THIRD-PARTY-NOTICES.md",
      "/files/share/doc/word-hunter/THIRD-PARTY-LICENSES.html",
      "/files/share/doc/word-hunter/OCR-THIRD-PARTY-LICENSES.html",
      "/files/share/applications/com.wordhunter.app.desktop",
      "/files/share/metainfo/com.wordhunter.app.metainfo.xml",
    ];
    for (const name of required) {
      if (!names.includes(name)) fail(`${path} is missing required Flatpak file: ${name}`);
    }
    if (names.filter((name) => /^\/files\/bin\/ocr-runtime\/models\/[^/]+\.onnx$/.test(name)).length < 3) {
      fail(`${path} must contain all three PaddleOCR ONNX models`);
    }
    for (const name of [
      "/files/bin/word-hunter-rustified",
      "/files/bin/ocr-runtime/bin/wordhunter-paddleocr",
      "/files/bin/syncthing",
    ]) {
      const bytes = run("ostree", ["cat", `--repo=${repo}`, ref, name], { binary: true });
      assertElfMachine(bytes, 62, `${path}:${name}`);
    }
    console.log(`Validated Flatpak bundle: ${path} (${names.length} files, x86_64)`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function usage() {
  console.error("Usage:");
  console.error("  node scripts/inspect-artifact.mjs android <apk-or-aab> --abi <arm64-v8a|x86_64>");
  console.error("  node scripts/inspect-artifact.mjs windows-portable <zip> [--require-dll <name>]...");
  console.error("  node scripts/inspect-artifact.mjs windows-nsis <exe> [--require-dll <name>]...");
  console.error("  node scripts/inspect-artifact.mjs flatpak <flatpak>");
  console.error("  node scripts/inspect-artifact.mjs linux-appimage <appimage>");
  console.error("  node scripts/inspect-artifact.mjs linux-deb <deb>");
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (!args[index + 1]) fail(`${name} requires a value`);
    values.push(args[index + 1]);
    index += 1;
  }
  return values;
}

function main(args) {
  const [kind, input, ...options] = args;
  if (!kind || !input) {
    usage();
    process.exitCode = 2;
    return;
  }
  const path = resolve(input);
  if (!statSync(path).isFile()) fail(`Artifact is not a file: ${path}`);
  const requiredDlls = optionValues(options, "--require-dll");
  switch (kind) {
    case "android": {
      const [abi] = optionValues(options, "--abi");
      if (!abi) fail("android inspection requires --abi");
      inspectAndroid(path, abi);
      break;
    }
    case "windows-portable":
      inspectWindowsPortable(path, requiredDlls);
      break;
    case "windows-nsis":
      inspectWindowsNsis(path, requiredDlls);
      break;
    case "flatpak":
      inspectFlatpak(path);
      break;
    case "linux-appimage":
      inspectLinuxAppImage(path);
      break;
    case "linux-deb":
      inspectLinuxDeb(path);
      break;
    default:
      usage();
      fail(`Unknown artifact kind: ${kind}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
