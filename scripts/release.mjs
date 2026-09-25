#!/usr/bin/env node
// Release version bumps. Replaces the one-off scripts-dev/bump-*.py copies.
//
//   node scripts/release.mjs prepare <version> [--notes <notes.json>] [--date YYYY-MM-DD]
//       Before tagging. Moves every version sink that must match the tagged
//       build (see scripts/check-version-sinks.sh) from the version in
//       src-tauri/Cargo.toml to <version>. Store recipes, README download
//       links and tests are never touched here.
//
//   node scripts/release.mjs pin-stores <stable-version> [--digests <digests.json>]
//       After a stable release is published. Points the Snap, Scoop,
//       Chocolatey, AUR and Nix recipes and the README download links at its
//       assets, using the digests the GitHub release reports (or an offline
//       {name: {sha256, size}} file).
//
// notes.json (required for a stable release, optional for an RC):
//   {
//     "whatsNew": { "en": "...", "pl": "...", ... },  // every locale, without the version prefix
//     "highlights": ["...", "..."],                    // AppStream <li> items
//     "debian": ["...", "..."],                        // optional, defaults to highlights
//     "fastlane": "..."                                // Play/F-Droid changelog body
//   }
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { androidVersionFor } = await import(pathToFileURL(join(root, "scripts", "android-version.mjs")).href);

const REPO = "Ironship/WordHunter";
const tag = (version) => `WordHunter${version}`;
const download = (version, asset) => `https://github.com/${REPO}/releases/download/${tag(version)}/${asset}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

const changed = [];
const read = (path) => readFileSync(join(root, path), "utf8");
function write(path, text) {
  if (existsSync(join(root, path)) && read(path) === text) return;
  writeFileSync(join(root, path), text);
  if (!changed.includes(path)) changed.push(path);
}
function replaceOnce(path, pattern, replacement) {
  const text = read(path);
  if (!pattern.test(text)) throw new Error(`${path}: ${pattern} not found`);
  write(path, text.replace(pattern, replacement));
}
function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}
function parseVersion(version) {
  const match = VERSION.exec(version || "");
  if (!match) throw new Error(`unsupported version "${version}" (use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N)`);
  return match;
}
function debianDate(date) {
  return new Date(`${date}T12:00:00Z`).toUTCString().replace("GMT", "+0000");
}

function prepare(next) {
  // Everything is validated before the first write, so a bad argument or
  // notes file leaves the tree untouched and the command can be re-run.
  const isRc = Boolean(parseVersion(next)[4]);
  const current = /^version = "([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))[1];
  const versionCode = androidVersionFor(next).code;
  const currentCode = JSON.parse(read("src-tauri/tauri.android.conf.json")).bundle.android.versionCode;
  if (!(versionCode > currentCode)) {
    throw new Error(`${next} (versionCode ${versionCode}) does not follow ${current} (versionCode ${currentCode})`);
  }
  const date = option("--date") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`--date must be a real YYYY-MM-DD date, got "${date}"`);
  }
  const notesPath = option("--notes");
  const notes = notesPath ? JSON.parse(readFileSync(notesPath, "utf8")) : {};
  if (!isRc) {
    for (const key of ["whatsNew", "highlights", "fastlane"]) {
      if (!notes[key]) throw new Error(`a stable release needs "${key}" in --notes`);
    }
  }
  for (const key of ["highlights", "debian"]) {
    if (notes[key] !== undefined && !(Array.isArray(notes[key]) && notes[key].every((item) => typeof item === "string" && item))) {
      throw new Error(`notes "${key}" must be a list of non-empty strings`);
    }
  }
  if (notes.fastlane !== undefined && typeof notes.fastlane !== "string") throw new Error('notes "fastlane" must be a string');
  const locales = readdirSync(join(root, "src", "web", "i18n")).filter((file) => file.endsWith(".json"));
  if (notes.whatsNew) {
    const expected = locales.map((file) => file.replace(/\.json$/, "")).sort().join(",");
    const provided = Object.keys(notes.whatsNew).sort().join(",");
    if (expected !== provided) throw new Error(`whatsNew locales ${provided} != ${expected}`);
  }
  if (!existsSync(join(root, "docs", "releases", `${next}.md`))) {
    throw new Error(`write docs/releases/${next}.md from docs/releases/TEMPLATE.md first`);
  }

  // Manifests. Only the word-hunter entry of Cargo.lock moves: third-party
  // crates can share the old version string.
  replaceOnce("src-tauri/Cargo.toml", new RegExp(`^version = "${escapeRegExp(current)}"`, "m"), `version = "${next}"`);
  replaceOnce(
    "src-tauri/Cargo.lock",
    new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "word-hunter"\\r?\\nversion = )"${escapeRegExp(current)}"`),
    `$1"${next}"`,
  );
  replaceOnce("src-tauri/tauri.conf.json", new RegExp(`"version": "${escapeRegExp(current)}"`), `"version": "${next}"`);
  replaceOnce("src-tauri/tauri.android.conf.json", /"versionCode": \d+/, `"versionCode": ${versionCode}`);

  // Locales: help.version and the version-prefixed release summary.
  for (const file of locales) {
    const path = `src/web/i18n/${file}`;
    const document = JSON.parse(read(path));
    const locale = file.replace(/\.json$/, "");
    document.help.version = next;
    document.help.whatsNew = notes.whatsNew
      ? `${next} ${notes.whatsNew[locale]}`
      : document.help.whatsNew.replace(new RegExp(`^${escapeRegExp(current)}`), next);
    write(path, `${JSON.stringify(document, null, 2)}\n`);
  }

  // Shipped legal files.
  replaceOnce("THIRD-PARTY-LICENSES.html", new RegExp(`word-hunter ${escapeRegExp(current)}<`), `word-hunter ${next}<`);
  replaceOnce("THIRD-PARTY-NOTICES.md", /distributed by Word Hunter \S+?\.(?=\s)/, `distributed by Word Hunter ${next}.`);
  replaceOnce("THIRD-PARTY-NOTICES.md", /tree\/WordHunter\S+/, `tree/${tag(next)}`);

  // AppStream (AppStream orders "~rc" before the final release) and its
  // byte-identical Flatpak copy.
  const metainfoPath = "packaging/linux/com.wordhunter.app.metainfo.xml";
  let metainfo = read(metainfoPath);
  const appstreamVersion = next.replace("-", "~");
  if (!metainfo.includes(`<release version="${appstreamVersion}"`)) {
    const entry = isRc
      ? `    <release version="${appstreamVersion}" date="${date}" type="development">\n` +
        `      <url>https://github.com/${REPO}/releases/tag/${tag(next)}</url>\n    </release>\n`
      : `    <release version="${next}" date="${date}">\n      <description>\n        <ul>\n` +
        notes.highlights.map((item) => `          <li>${item}</li>\n`).join("") +
        "        </ul>\n      </description>\n    </release>\n";
    if (!metainfo.includes("  <releases>\n")) throw new Error(`${metainfoPath}: <releases> not found`);
    metainfo = metainfo.replace("  <releases>\n", `  <releases>\n${entry}`);
    write(metainfoPath, metainfo);
  }
  write("flatpak/com.wordhunter.app.metainfo.xml", metainfo);

  const debianPath = "packaging/linux/debian-changelog";
  const debian = read(debianPath);
  if (!debian.startsWith(`word-hunter (${next}) `)) {
    const items = notes.debian || notes.highlights || [`Release candidate ${next}.`];
    write(
      debianPath,
      `word-hunter (${next}) unstable; urgency=medium\n\n` +
        items.map((item) => `  * ${item}\n`).join("") +
        `\n -- Word Hunter maintainers <maintainers@wordhunter.app>  ${debianDate(date)}\n\n` +
        debian,
    );
  }

  // Store changelog for the versionCode that reaches Play and F-Droid.
  if (notes.fastlane) {
    write(`fastlane/metadata/android/en-US/changelogs/${versionCode}.txt`, `Word Hunter ${next}\n\n${notes.fastlane.trim()}\n`);
  }

  console.log(`prepared ${current} -> ${next} (versionCode ${versionCode}); changed:`);
  for (const path of changed) console.log(`  ${path}`);
  if (process.argv.includes("--no-check")) return;
  if (process.platform === "win32") {
    // "bash" may resolve to WSL or not at all here; leave it to Git Bash.
    console.log(`Now run ./scripts/check-version-sinks.sh ${next} from Git Bash.`);
    return;
  }
  execFileSync("bash", [join(root, "scripts", "check-version-sinks.sh"), next], { stdio: "inherit", cwd: root });
}

async function releaseDigests(version) {
  const file = option("--digests");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag(version)}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`release ${tag(version)}: HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error(`${tag(version)} is not a published stable release`);
  return Object.fromEntries(release.assets.map((asset) => [
    asset.name,
    { sha256: String(asset.digest || "").replace(/^sha256:/, ""), size: asset.size },
  ]));
}

async function pinStores(version) {
  if (parseVersion(version)[4]) throw new Error("store recipes only point at stable releases");
  const assets = await releaseDigests(version);
  const asset = (name) => {
    if (!/^[0-9a-f]{64}$/.test(assets[name]?.sha256 || "")) throw new Error(`${tag(version)} has no digest for ${name}`);
    return assets[name];
  };
  const deb = asset(`word-hunter_${version}_amd64.deb`);
  const zip = asset("Word.Hunter.portable.zip");
  const exe = asset("Word.Hunter.Setup.exe");
  const appImage = asset(`WordHunter-${version}-x86_64.AppImage`);

  // Recipes are rewritten by pattern rather than by their previous version:
  // they have drifted independently before.
  const anyVersion = String.raw`\d+\.\d+\.\d+(?:-rc\.\d+)?`;
  const pinUrls = (text) => text
    .replace(new RegExp(`releases/(download|tag)/WordHunter${anyVersion}`, "g"), `releases/$1/${tag(version)}`)
    .replace(new RegExp(`(blob|tree)/WordHunter${anyVersion}`, "g"), `$1/${tag(version)}`)
    .replace(new RegExp(`@WordHunter${anyVersion}`, "g"), `@${tag(version)}`)
    .replace(new RegExp(`word-hunter_${anyVersion}_amd64`, "g"), `word-hunter_${version}_amd64`)
    .replace(new RegExp(`WordHunter-${anyVersion}-(x86_64|aarch64)`, "g"), `WordHunter-${version}-$1`);

  write(
    "snap/snapcraft.yaml",
    pinUrls(read("snap/snapcraft.yaml"))
      .replace(/^version: '[^']+'/m, `version: '${version}'`)
      .replace(/source-checksum: sha256\/[0-9a-f]{64}/, `source-checksum: sha256/${deb.sha256}`),
  );
  write(
    "packaging/snap/README.md",
    pinUrls(read("packaging/snap/README.md"))
      .replace(/pinned input for version \S+ is:/, `pinned input for version ${version} is:`)
      .replace(/size: `[\d,]+` bytes/, `size: \`${deb.size.toLocaleString("en-US")}\` bytes`)
      .replace(/SHA-256: `[0-9a-f]{64}`/, `SHA-256: \`${deb.sha256}\``),
  );

  const scoop = JSON.parse(read("packaging/scoop/wordhunter.json"));
  scoop.version = version;
  scoop.architecture["64bit"].url = download(version, "Word.Hunter.portable.zip");
  scoop.architecture["64bit"].hash = zip.sha256;
  write("packaging/scoop/wordhunter.json", `${JSON.stringify(scoop, null, 4)}\n`);

  // The four Chocolatey files must name the same URL and digest.
  for (const path of [
    "packaging/chocolatey/wordhunter.nuspec",
    "packaging/chocolatey/tools/chocolateyInstall.ps1",
    "packaging/chocolatey/tools/VERIFICATION.txt",
    "packaging/chocolatey/README.md",
  ]) {
    write(
      path,
      pinUrls(read(path))
        .replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`)
        .replace(/official \S+ release asset/, `official ${version} release asset`)
        .replace(/Application version: `[^`]+`/, `Application version: \`${version}\``)
        .replace(/[0-9a-f]{64}/gi, exe.sha256),
    );
  }

  write(
    "packaging/aur/PKGBUILD",
    read("packaging/aur/PKGBUILD")
      .replace(/^pkgver=.+$/m, `pkgver=${version}`)
      .replace(/^pkgrel=.+$/m, "pkgrel=1")
      .replace(/sha256sums_x86_64=\('[^']*'\)/, `sha256sums_x86_64=('${appImage.sha256}')`),
  );
  write(
    "packaging/aur/.SRCINFO",
    pinUrls(read("packaging/aur/.SRCINFO"))
      .replace(/pkgver = .+/, `pkgver = ${version}`)
      .replace(/pkgrel = .+/, "pkgrel = 1")
      .replace(/provides = wordhunter=.+/, `provides = wordhunter=${version}`)
      .replace(/sha256sums_x86_64 = .+/, `sha256sums_x86_64 = ${appImage.sha256}`),
  );

  // Nix takes the same SHA-256 as an SRI hash.
  const sri = `sha256-${Buffer.from(appImage.sha256, "hex").toString("base64")}`;
  write(
    "packaging/nix/package.nix",
    read("packaging/nix/package.nix")
      .replace(/version = "[^"]+";/, `version = "${version}";`)
      .replace(/hash = "sha256-[^"]+";/, `hash = "${sri}";`),
  );

  // README: versioned download links, CLI examples and release status. The
  // unversioned assets use releases/latest and need no edit.
  write(
    "README.md",
    pinUrls(read("README.md"))
      .replace(new RegExp(`Word Hunter ${anyVersion}\\]\\(`, "g"), `Word Hunter ${version}](`)
      .replace(new RegExp(`\\[${anyVersion}\\]\\(`, "g"), `[${version}](`)
      .replace(new RegExp(`newer than ${anyVersion} right`, "g"), `newer than ${version} right`),
  );

  console.log(`pinned store recipes to ${version}; changed:`);
  for (const path of changed) console.log(`  ${path}`);
  console.log(`Rewrite the README "Version ${version} ..." summary by hand.`);
  console.log("Also update outside this repository: the winget manifest, the Homebrew cask, choco push, and the AUR push.");
}

const [command, version] = process.argv.slice(2);
if (command === "prepare" && version) prepare(version);
else if (command === "pin-stores" && version) await pinStores(version);
else {
  console.error("usage: node scripts/release.mjs prepare <version> [--notes <file>] [--date YYYY-MM-DD]");
  console.error("       node scripts/release.mjs pin-stores <stable-version> [--digests <file>]");
  process.exit(2);
}
