#!/usr/bin/env bash
set -euo pipefail

# Version-sinks drift guard (non-security, storage/packaging hygiene).
#
# The canonical app version lives in the Rust crate (src-tauri/Cargo.toml);
# release bumps update it first and then push it into every other manifest.
# This check hard-fails when one of the strictly-synced sinks drifts, so a
# half-finished bump cannot ship a Flatpak/AppStream build that reports a
# different version than the actual binary. Store recipes that repackage a
# published release asset (Snap, AUR) are advisory only: they can move only
# after that release exists.
#
# Usage: ./scripts/check-version-sinks.sh [expected-version]

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the version-sinks check." >&2
  exit 2
fi

failures=0
pass() { printf 'OK   %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1" >&2; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

cargo_version="$(sed -n 's/^version = "\([^"]*\)"/\1/p' src-tauri/Cargo.toml | head -n1)"
if [[ -z "$cargo_version" ]]; then
  echo "could not read version from src-tauri/Cargo.toml" >&2
  exit 2
fi
if [[ -n "${1:-}" && "$1" != "$cargo_version" ]]; then
  fail "src-tauri/Cargo.toml version $cargo_version != expected $1"
fi

# --- src-tauri/tauri.conf.json (Tauri bundle identity) ---
conf_version="$(node -e 'process.stdout.write(String(require("./src-tauri/tauri.conf.json").version))')"
if [[ "$conf_version" == "$cargo_version" ]]; then
  pass "src-tauri/tauri.conf.json ($conf_version)"
else
  fail "src-tauri/tauri.conf.json version $conf_version != Cargo.toml $cargo_version"
fi

# --- src-tauri/Cargo.lock (the app crate's pinned version) ---
lock_version="$(
  node -e '
    const fs = require("fs");
    const text = fs.readFileSync("src-tauri/Cargo.lock", "utf8");
    for (const block of text.split("\n[[package]]").slice(1)) {
      const name = block.match(/name = "([^"]+)"/);
      if (name && name[1] === "word-hunter") {
        const version = block.match(/version = "([^"]+)"/);
        if (version) process.stdout.write(version[1]);
        break;
      }
    }
  '
)"
if [[ -z "$lock_version" ]]; then
  fail "src-tauri/Cargo.lock has no word-hunter package entry"
elif [[ "$lock_version" == "$cargo_version" ]]; then
  pass "src-tauri/Cargo.lock word-hunter ($lock_version)"
else
  fail "src-tauri/Cargo.lock word-hunter version $lock_version != Cargo.toml $cargo_version"
fi

# --- i18n locales (help.version shown in the app) ---
for locale in src/web/i18n/*.json; do
  locale_version="$(
    node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String((d.help || {}).version || ""))' "$locale"
  )"
  if [[ "$locale_version" == "$cargo_version" ]]; then
    pass "$locale ($locale_version)"
  else
    fail "$locale help.version $locale_version != Cargo.toml $cargo_version"
  fi
done

# --- AppStream metainfo: latest <release> + the Flatpak mirror ---
metainfo="packaging/linux/com.wordhunter.app.metainfo.xml"
metainfo_version="$(
  grep -o '<release version="[^"]*"' "$metainfo" | head -n1 | sed 's/<release version="\([^"]*\)"/\1/'
)"
# AppStream coerces '-' to '~' in versions (e.g. 1.0.14-rc.1 -> 1.0.14~rc.1).
normalized="$(printf '%s' "$cargo_version" | tr '-' '~')"
if [[ -n "$metainfo_version" ]]; then
  if [[ "$metainfo_version" == "$normalized" ]]; then
    pass "$metainfo latest release ($metainfo_version)"
  else
    fail "$metainfo latest release $metainfo_version != normalized $normalized (from Cargo.toml)"
  fi
else
  fail "$metainfo has no <release> entry"
fi
if diff -q "$metainfo" flatpak/com.wordhunter.app.metainfo.xml >/dev/null 2>&1; then
  pass "flatpak/com.wordhunter.app.metainfo.xml mirrors the packaging template"
else
  fail "flatpak/com.wordhunter.app.metainfo.xml does not match $metainfo"
fi

# --- Files shipped in or published with the release ---
if head -n1 packaging/linux/debian-changelog | grep -Fq "word-hunter ($cargo_version) "; then
  pass "packaging/linux/debian-changelog top entry ($cargo_version)"
else
  fail "packaging/linux/debian-changelog does not start with a word-hunter ($cargo_version) entry"
fi
if grep -Fq "distributed by Word Hunter $cargo_version." THIRD-PARTY-NOTICES.md \
  && grep -Fq "tree/WordHunter$cargo_version" THIRD-PARTY-NOTICES.md; then
  pass "THIRD-PARTY-NOTICES.md names $cargo_version and its source tree"
else
  fail "THIRD-PARTY-NOTICES.md does not name Word Hunter $cargo_version and tree/WordHunter$cargo_version"
fi
if [[ -f "docs/releases/$cargo_version.md" ]]; then
  pass "docs/releases/$cargo_version.md (release body)"
else
  fail "docs/releases/$cargo_version.md is missing; it is the GitHub release body"
fi
if [[ "$cargo_version" != *-* ]]; then
  version_code="$(node -p 'require("./src-tauri/tauri.android.conf.json").bundle.android.versionCode')"
  if [[ -f "fastlane/metadata/android/en-US/changelogs/$version_code.txt" ]]; then
    pass "fastlane changelog $version_code.txt"
  else
    fail "fastlane/metadata/android/en-US/changelogs/$version_code.txt is missing for stable $cargo_version"
  fi
fi

# --- Advisory: store recipes that repackage a published release asset ---
# Snap, AUR, Nix, Scoop and Chocolatey download the released DEB, AppImage or
# ZIP and pin its checksum, which cannot exist before the release is
# published. They move to a new version in the post-release commit, so they
# lag the in-tree version between the bump and that commit.
snap_version="$(sed -n "s/^version: ['\"]\([^'\"]*\)['\"]/\1/p" snap/snapcraft.yaml | head -n1)"
if [[ -z "$snap_version" ]]; then
  fail "snap/snapcraft.yaml has no top-level version"
elif [[ "$snap_version" != "$cargo_version" ]]; then
  warn "snap/snapcraft.yaml version=$snap_version (canonical $cargo_version); updated after the release is published"
fi
if [[ -f packaging/aur/PKGBUILD ]]; then
  aur_version="$(sed -n 's/^pkgver=//p' packaging/aur/PKGBUILD | head -n1)"
  if [[ "$aur_version" != "$cargo_version" ]]; then
    warn "packaging/aur/PKGBUILD pkgver=$aur_version (canonical $cargo_version); AUR is maintained separately"
  fi
fi

if [[ "$failures" -ne 0 ]]; then
  echo
  echo "version sinks are out of sync ($failures problem(s)); run node scripts/release.mjs prepare <version> to update them." >&2
  exit 1
fi
echo "version sinks OK: $cargo_version"
