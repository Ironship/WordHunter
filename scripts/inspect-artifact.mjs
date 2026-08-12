#!/usr/bin/env node

import { inflateRawSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
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
    if (name && entries.has(name.toLowerCase())) {
      // AGP resource optimization can legitimately emit duplicate res/
      // entries in release (minified) APKs; everything else is a real
      // packaging defect.
      if (!name.startsWith("res/")) fail(`${path} contains duplicate entry: ${name}`);
    }
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

// Must mirror scripts/build.bat Get-AndroidVersionInfo: the project overrides
// the versionCode tauri-cli would emit (see the Pocket Play history) with
//   1000000 + ((major*1e6 + minor*1e3 + patch) * 100) + releaseOrdinal
// where releaseOrdinal is 99 for a stable release, the rc number for
// -rc.N, and 100 for a +1 hotfix. Keeping it in sync with build.bat keeps
// the artifact assertion correct across version bumps.
export function androidVersionCodeFor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:(?:-rc\.(\d+))|(?:\+(\d+)))?$/.exec(version);
  if (!match) fail(`Cannot derive an Android versionCode from version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor > 999 || patch > 999) {
    fail(`Android versionCode formula requires MINOR and PATCH below 1000: ${version}`);
  }
  const baseCode = major * 1_000_000 + minor * 1_000 + patch;
  let releaseOrdinal = 99;
  if (match[4]) {
    releaseOrdinal = Number(match[4]);
    if (releaseOrdinal < 1 || releaseOrdinal > 98) {
      fail(`Android release-candidate ordinal must be between 1 and 98: ${version}`);
    }
  } else if (match[5]) {
    if (Number(match[5]) !== 1) {
      fail(`Android four-part hotfix version must end in +1: ${version}`);
    }
    releaseOrdinal = 100;
  }
  return 1_000_000 + baseCode * 100 + releaseOrdinal;
}

export function parseBadgingPackage(badging) {
  const match = badging.match(/^package:\s*name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  if (!match) return null;
  return { name: match[1], versionCode: Number(match[2]), versionName: match[3] };
}

// `aapt2 dump badging` only prints `application-debuggable` when the APK is
// debuggable, so release artifacts must never contain that line.
export function isBadgingDebuggable(badging) {
  return /^application-debuggable/m.test(badging);
}

export function parseXmlTreeManifest(xmltree) {
  const versionCodeMatch = xmltree.match(/android:versionCode\(0x0101021b\)=\(type 0x10\)0x([0-9a-f]+)/i);
  const versionNameMatch = xmltree.match(/android:versionName\(0x0101021c\)="([^"]+)"/);
  const debuggableMatch = xmltree.match(/android:debuggable\(0x0101000f\)=\(type 0x12\)0x([0-9a-f]+)/i);
  return {
    versionCode: versionCodeMatch ? parseInt(versionCodeMatch[1], 16) : null,
    versionName: versionNameMatch ? versionNameMatch[1] : null,
    debuggable: debuggableMatch ? parseInt(debuggableMatch[1], 16) !== 0 : false,
  };
}

// AABs carry the original AndroidManifest.xml at the archive root
// (manifest/AndroidManifest.xml). Recent AGP versions produce AABs whose
// protobuf manifest (base/manifest/) aapt2 from newer build-tools refuses to
// read ("could not identify format of APK"), so the AAB version identity is
// verified from the root manifest instead: text XML when present, binary
// AXML otherwise.
export function parseTextManifest(xml) {
  const tag = xml.match(/<manifest[^>]*>/);
  if (!tag) return { versionCode: null, versionName: null, debuggable: false };
  const attrs = tag[0];
  const versionCodeMatch = attrs.match(/versionCode="(\d+)"/);
  const versionNameMatch = attrs.match(/versionName="([^"]+)"/);
  const debuggableMatch = attrs.match(/android:debuggable="(true|false)"/);
  return {
    versionCode: versionCodeMatch ? Number(versionCodeMatch[1]) : null,
    versionName: versionNameMatch ? versionNameMatch[1] : null,
    debuggable: debuggableMatch ? debuggableMatch[1] === "true" : false,
  };
}

// Binary AXML: chunked format with a string pool (0x0001), a resource map
// (0x0180) mapping string indices to resource ids, and start-element chunks
// (0x0102) carrying typed attributes. The manifest's versionCode
// (0x0101021b), versionName (0x0101021c), and debuggable (0x0101000f)
// attributes are located by resource id and decoded from the typed value.
const AXML_VERSION_CODE_ID = 0x0101021b;
const AXML_VERSION_NAME_ID = 0x0101021c;
const AXML_DEBUGGABLE_ID = 0x0101000f;

export function parseAxmlManifest(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x00080003) {
    return { versionCode: null, versionName: null, debuggable: false, axml: false };
  }
  let strings = [];
  const resourceMap = [];
  const found = { versionCode: null, versionName: null, debuggable: false, axml: true };
  const u16 = (at) => (at + 2 <= bytes.length ? bytes.readUInt16LE(at) : 0);
  const u32 = (at) => (at + 4 <= bytes.length ? bytes.readUInt32LE(at) : 0);
  const u8 = (at) => (at + 1 <= bytes.length ? bytes.readUInt8(at) : 0);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = u16(offset);
    const chunkSize = u32(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > bytes.length) break;
    if (type === 0x0001) {
      const stringCount = u32(offset + 8);
      const stringsStart = u32(offset + 20);
      const stringPoolBase = offset + stringsStart;
      for (let index = 0; index < stringCount; index += 1) {
        const stringOffset = u32(offset + 28 + index * 4);
        const at = stringPoolBase + stringOffset;
        if (at + 2 > bytes.length) break;
        const length = u16(at);
        const end = at + 2 + length * 2;
        if (end > bytes.length) break;
        strings.push(bytes.toString("utf16le", at + 2, end));
      }
    } else if (type === 0x0180) {
      for (let at = offset + 8; at + 4 <= offset + chunkSize; at += 4) {
        resourceMap.push(u32(at));
      }
    } else if (type === 0x0102) {
      const attrCount = u16(offset + 28);
      let attrOffset = offset + 32;
      for (let index = 0; index < attrCount; index += 1) {
        const nameField = u32(attrOffset + 4);
        const valueType = u8(attrOffset + 12);
        const valueData = u32(attrOffset + 16);
        let resourceId = nameField;
        if (nameField & 0x80000000) resourceId = nameField & 0x7fffffff;
        else if (nameField < resourceMap.length) resourceId = resourceMap[nameField];
        if (resourceId === AXML_VERSION_CODE_ID) {
          found.versionCode = valueData;
        } else if (resourceId === AXML_VERSION_NAME_ID) {
          if (valueType === 0x03 && valueData < strings.length) found.versionName = strings[valueData];
          else if (valueType === 0x01) found.versionName = strings[valueData];
        } else if (resourceId === AXML_DEBUGGABLE_ID) {
          found.debuggable = valueData !== 0;
        }
        attrOffset += 20;
      }
    }
    offset += chunkSize;
  }
  return found;
}

// The AGP-produced AAB keeps its manifest only as protobuf under base/
// (no root text/AXML copy), so the version identity is also parsed from the
// protobuf wire format directly (no schema library needed):
//   Manifest { XmlNode manifest = 1 }
//   XmlNode  { XmlElement element = 3 }
//   XmlElement { string name = 1; ...; XmlAttribute attribute = 5; ... }
//   XmlAttribute { ...; int32 resource_id = 5; TypedValue typed_value = 6; }
//   TypedValue { int32 type = 1; int32 value = 2; string string_value = 3; }
export function parseProtoManifest(bytes) {
  const found = { versionCode: null, versionName: null, debuggable: false, attrs: [] };

  function varint(at) {
    let value = 0;
    let shift = 0;
    while (at < bytes.length && shift < 64) {
      const byte = bytes[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return { value: value >>> 0, at };
      shift += 7;
    }
    return { value: 0, at };
  }

  function lengthDelimited(at) {
    const len = varint(at);
    const start = len.at;
    const end = start + len.value;
    if (end > bytes.length) return null;
    return { start, end };
  }

  // Collect XmlAttribute payloads from an XmlElement message (field 5).
  function collectAttributes(payload, out) {
    let at = payload.start;
    while (at < payload.end) {
      const tag = varint(at);
      at = tag.at;
      const fieldNumber = tag.value >>> 3;
      const wireType = tag.value & 0x7;
      if (wireType === 2) {
        const ld = lengthDelimited(at);
        if (!ld) return;
        if (fieldNumber === 5) out.push({ start: ld.start, end: ld.end });
        at = ld.end;
      } else if (wireType === 0) {
        at = varint(at).at;
      } else {
        return;
      }
    }
  }

  // The AAB manifest is a bare aapt.pb.XmlNode; older builds wrap it in
  // aapt.pb.Manifest { XmlNode manifest = 1 }. Accept both: scan the
  // top-level fields AND the payload of a top-level field 1 (the wrapper).
  const candidates = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = varint(at);
    at = tag.at;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 2) {
      const ld = lengthDelimited(at);
      if (!ld) break;
      if (fieldNumber === 5) candidates.push({ start: ld.start, end: ld.end });
      else if (fieldNumber === 1) {
        // Wrapper (Manifest.manifest) — the XmlNode payload may hold an
        // XmlElement at field 5; push the ELEMENT, not the wrapper.
        const inner = [];
        collectAttributes(ld, inner);
        if (inner.length > 0) candidates.push(inner[0]);
      }
      at = ld.end;
    } else if (wireType === 0) {
      at = varint(at).at;
    } else {
      break;
    }
  }

  const attributes = [];
  for (const candidate of candidates) collectAttributes(candidate, attributes);
  for (const attr of attributes) {
    let resourceId = null;
    let name = null;
    let typedValue = null;
    let at = attr.start;
    while (at < attr.end) {
      const tag = varint(at);
      at = tag.at;
      const fieldNumber = tag.value >>> 3;
      const wireType = tag.value & 0x7;
      if (wireType === 2) {
        const ld = lengthDelimited(at);
        if (!ld) break;
        if (fieldNumber === 2) name = bytes.toString("utf8", ld.start, ld.end);
        else if (fieldNumber === 5) resourceId = varint(ld.start).value;
        else if (fieldNumber === 6) typedValue = { start: ld.start, end: ld.end };
        at = ld.end;
      } else if (wireType === 0) {
        at = varint(at).at;
      } else {
        break;
      }
    }
    if (typedValue === null) continue;
    found.attrs.push({ resourceId, name });
    if (resourceId === 0x0101021b || name === "versionCode") {
      let at2 = typedValue.start;
      while (at2 < typedValue.end) {
        const tag = varint(at2);
        at2 = tag.at;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x7;
        if (wireType === 2) {
          const ld = lengthDelimited(at2);
          if (!ld) break;
          if (fieldNumber === 3) found.versionName = bytes.toString("utf8", ld.start, ld.end);
          at2 = ld.end;
        } else if (wireType === 0) {
          if (fieldNumber === 2) found.versionCode = varint(at2).value;
          at2 = varint(at2).at;
        } else {
          break;
        }
      }
    } else if (resourceId === 0x0101021c || name === "versionName") {
      let at2 = typedValue.start;
      while (at2 < typedValue.end) {
        const tag = varint(at2);
        at2 = tag.at;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x7;
        if (wireType === 2) {
          const ld = lengthDelimited(at2);
          if (!ld) break;
          if (fieldNumber === 3) found.versionName = bytes.toString("utf8", ld.start, ld.end);
          at2 = ld.end;
        } else if (wireType === 0) {
          at2 = varint(at2).at;
        } else {
          break;
        }
      }
    } else if (resourceId === 0x0101000f || name === "debuggable") {
      let at2 = typedValue.start;
      while (at2 < typedValue.end) {
        const tag = varint(at2);
        at2 = tag.at;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x7;
        if (wireType === 0) {
          if (fieldNumber === 2) found.debuggable = varint(at2).value !== 0;
          at2 = varint(at2).at;
        } else if (wireType === 2) {
          const ld = lengthDelimited(at2);
          if (!ld) break;
          at2 = ld.end;
        } else {
          break;
        }
      }
    }
  }
  return found;
}
export function readZipEntryText(archive, name) {
  const entry = archive.entries.get(name.toLowerCase());
  if (!entry) return null;
  return zipEntryBytes(archive, entry).toString("utf8");
}

function androidExpectations() {
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  // The Android package name is the mobile identifier (tauri.android.conf.json
  // overrides the desktop one — see the Word.Hunter.Pocket artifact naming),
  // while versionCode/versionName still derive from the shared app version.
  let androidConfig = null;
  try {
    androidConfig = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.android.conf.json", import.meta.url), "utf8"),
    );
  } catch {
    // Fall through to the desktop identifier when the android overlay is absent.
  }
  return {
    packageName: androidConfig?.identifier ?? config.identifier,
    versionName: config.version,
    versionCode: androidVersionCodeFor(config.version),
  };
}

function findAapt2() {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdkRoot) {
    fail("ANDROID_HOME/ANDROID_SDK_ROOT is not set; cannot locate aapt2 for the release APK/AAB assertions");
  }
  const buildTools = join(sdkRoot, "build-tools");
  let versions;
  try {
    versions = readdirSync(buildTools, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    fail(`No Android build-tools directory found below ${sdkRoot}`);
  }
  if (versions.length === 0) fail(`No Android build-tools versions found below ${buildTools}`);
  // Prefer the version the release workflow pins via ANDROID_BUILD_TOOLS:
  // newer runner images preinstall newer build-tools whose aapt2 regressed
  // AAB manifest parsing, so picking the highest version is not safe.
  const pinned = process.env.ANDROID_BUILD_TOOLS;
  if (pinned && versions.includes(pinned)) {
    return join(buildTools, pinned, process.platform === "win32" ? "aapt2.exe" : "aapt2");
  }
  versions.sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (right[index] ?? 0) - (left[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  for (const version of versions) {
    const candidate = join(buildTools, version, process.platform === "win32" ? "aapt2.exe" : "aapt2");
    if (existsSync(candidate)) return candidate;
  }
  fail(`aapt2 was not found below ${buildTools}`);
}

// Issue #138: zip-level checks (naming, manifest, dex, single ABI, ELF
// machine, forbidden OCR runtime) — SDK-free so unit tests can exercise them
// with synthetic archives. The aapt2 release assertions live in
// inspectAndroid() and require ANDROID_HOME.
export function inspectAndroidZipList(path, abi) {
  const archive = readZipArchive(path);
  const names = namesOf(archive);
  const isAab = path.toLowerCase().endsWith(".aab");
  const expectedName = isAab ? "Word.Hunter.Pocket.release.aab" : "Word.Hunter.Pocket.release.apk";
  if (basename(path) !== expectedName) {
    fail(`${path} must be named ${expectedName}`);
  }
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

export function inspectAndroid(path, abi) {
  inspectAndroidZipList(path, abi);
  const isAab = path.toLowerCase().endsWith(".aab");
  // Issue #138: the shipped artifact must be a release build — matching
  // versionCode/versionName from tauri.conf.json and never debuggable.
  const expected = androidExpectations();
  const aapt2 = findAapt2();
  if (isAab) {
    const archive = readZipArchive(path);
    // AGP-produced AABs keep the manifest only as protobuf under base/; the
    // root text/AXML copy exists on older bundletool versions. Try every
    // representation before failing.
    let manifest = null;
    const manifestXml = readZipEntryText(archive, "manifest/AndroidManifest.xml");
    if (manifestXml !== null) {
      manifest = parseTextManifest(manifestXml);
      if (manifest.versionCode === null && manifest.versionName === null) {
        manifest = parseAxmlManifest(Buffer.from(manifestXml, "utf8"));
      }
    }
    if (!manifest || (manifest.versionCode === null && manifest.versionName === null)) {
      const protoEntry = archive.entries.get("base/manifest/androidmanifest.xml");
      if (protoEntry) {
        const protoBytes = zipEntryBytes(archive, protoEntry);
        manifest = parseProtoManifest(protoBytes);
        if (manifest.versionCode === null && manifest.versionName === null) {
          // Some bundletool versions store the base/ manifest as binary AXML.
          manifest = parseAxmlManifest(protoBytes);
        }
      }
    }
    if (!manifest || (manifest.versionCode === null && manifest.versionName === null)) {
      const protoEntry = archive.entries.get("base/manifest/androidmanifest.xml");
      const protoDiag = protoEntry
        ? parseProtoManifest(zipEntryBytes(archive, protoEntry)).attrs.map((a) => (a.name ?? "") + "=" + (a.resourceId === null ? "-" : "0x" + a.resourceId.toString(16))).join(",")
        : "no base/manifest entry";
      fail(`${path}: could not determine the version identity from the AAB manifest (proto attrs: ${protoDiag})`);
    }
    if (manifest.versionCode !== expected.versionCode) {
      fail(`${path} has versionCode ${manifest.versionCode}; expected ${expected.versionCode} (from tauri.conf.json version ${expected.versionName})`);
    }
    if (manifest.versionName !== expected.versionName) {
      fail(`${path} has versionName ${manifest.versionName}; expected ${expected.versionName}`);
    }
    if (manifest.debuggable) fail(`${path} is debuggable; release builds must not set android:debuggable`);
  } else {
    const badging = run(aapt2, ["dump", "badging", path]);
    const packageInfo = parseBadgingPackage(badging);
    if (!packageInfo) fail(`${path}: aapt2 dump badging reported no package line`);
    if (packageInfo.name !== expected.packageName) {
      fail(`${path} has package ${packageInfo.name}; expected ${expected.packageName}`);
    }
    if (packageInfo.versionCode !== expected.versionCode) {
      fail(`${path} has versionCode ${packageInfo.versionCode}; expected ${expected.versionCode} (from tauri.conf.json version ${expected.versionName})`);
    }
    if (packageInfo.versionName !== expected.versionName) {
      fail(`${path} has versionName ${packageInfo.versionName}; expected ${expected.versionName}`);
    }
    if (isBadgingDebuggable(badging)) {
      fail(`${path} is a debuggable APK; release builds must not set android:debuggable`);
    }
  }
}

export function inspectWindowsPortable(path, requiredDlls = []) {
  const archive = readZipArchive(path);
  const names = namesOf(archive);
  const required = [
    "Word.Hunter.portable.exe",
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
  const mediaRuntime = [];
  if (format === "appimage") {
    requireSuffix(names, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh");
    for (const plugin of [
      "usr/lib/gstreamer-1.0/libgstcoreelements.so",
      "usr/lib/gstreamer-1.0/libgstplayback.so",
      "usr/lib/gstreamer-1.0/libgstautodetect.so",
    ]) {
      mediaRuntime.push(requireSuffix(names, plugin));
    }
  }

  const models = names.filter((name) => (
    name.toLowerCase().startsWith("usr/lib/") &&
    /\/ocr-runtime\/models\/[^/]+\.onnx$/i.test(name)
  ));
  if (models.length < 3) fail(`${description} must contain all three PaddleOCR ONNX models`);

  for (const legalFile of [
    ...legalFiles,
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
    !/<launchable type="desktop-id">com\.wordhunter\.app\.desktop<\/launchable>/.test(appStreamSource)
  ) {
    fail(`${description}:${appStream} is not Word Hunter AppStream metadata`);
  }

  for (const name of [main, ocrRunner, pdfium, webGpuDawn, ...mediaRuntime].filter(Boolean)) {
    assertElfMachine(
      readFileSync(localArtifactPath(root, name)),
      62,
      `${description}:${name}`,
    );
  }
  assertExecutable(root, main, description);
  assertExecutable(root, ocrRunner, description);
  if (format === "deb") {
    requireSuffix(names, "usr/share/doc/word-hunter/copyright");
    requireSuffix(names, "usr/share/doc/word-hunter/changelog.Debian.gz");
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

export function debianVersionForRelease(version) {
  return version.replace(/-rc\.(\d+)$/, "~rc.$1");
}

export const DEB_REQUIRED_DEPENDS = [
  "libc6",
  "libgtk-3-0",
  "libwebkit2gtk-4.1-0",
  "poppler-utils",
  "gstreamer1.0-plugins-base",
  "gstreamer1.0-plugins-good",
];

export function inspectLinuxDeb(path) {
  const packageName = run("dpkg-deb", ["--field", path, "Package"]).trim();
  if (packageName !== "word-hunter") fail(`${path} has Debian package name ${packageName || "unknown"}; expected word-hunter`);
  const version = run("dpkg-deb", ["--field", path, "Version"]).trim();
  const filename = basename(path).match(/^word-hunter_(.+)_amd64\.deb$/);
  if (!filename || version.replace("+", ".") !== debianVersionForRelease(filename[1])) {
    fail(`${path} has Debian version ${version || "unknown"} inconsistent with its release filename`);
  }
  const architecture = run("dpkg-deb", ["--field", path, "Architecture"]).trim();
  if (architecture !== "amd64") fail(`${path} has Debian architecture ${architecture || "unknown"}; expected amd64`);
  const maintainer = run("dpkg-deb", ["--field", path, "Maintainer"]).trim();
  if (!/^Ironship <[^<>\s]+@users\.noreply\.github\.com>$/.test(maintainer)) {
    fail(`${path} has invalid Debian Maintainer metadata: ${maintainer || "missing"}`);
  }
  const dependencies = run("dpkg-deb", ["--field", path, "Depends"]).trim();
  for (const dependency of DEB_REQUIRED_DEPENDS) {
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
      (name) => !/wordhunter-paddleocr|uninstall|uninst/i.test(basename(name)),
    );
    if (!main) fail(`${path} contains no installed application executable`);
    for (const name of [
      main,
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
      "/files/share/licenses/com.wordhunter.app/LICENSE",
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
