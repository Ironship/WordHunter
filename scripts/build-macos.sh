#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

die() {
  echo "error: $*" >&2
  exit 1
}

for command_name in cargo codesign file hdiutil npm node; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

[[ "$(uname -s)" == "Darwin" ]] || die "the macOS DMG must be built on macOS"
[[ "$(uname -m)" == "arm64" ]] || die "the current DMG recipe targets Apple Silicon"

version="$(node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")); if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(c.version)) process.exit(1); process.stdout.write(c.version);')" \
  || die "src-tauri/tauri.conf.json does not contain a valid package version"

if [[ ! -d node_modules ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
npm run build:frontend

cargo tauri build \
  --bundles dmg \
  --target aarch64-apple-darwin \
  --config "$root/src-tauri/tauri.macos.conf.json"

bundle_dir="$root/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
shopt -s nullglob
built_dmgs=("$bundle_dir"/*.dmg)
shopt -u nullglob
[[ ${#built_dmgs[@]} -eq 1 ]] || die "expected exactly one DMG in $bundle_dir, found ${#built_dmgs[@]}"

mkdir -p "$root/outputs"
output="$root/outputs/WordHunter-${version}-aarch64.dmg"
cp "${built_dmgs[0]}" "$output"

mount_dir="$(mktemp -d)"
attached=0
cleanup() {
  if [[ "$attached" == "1" ]]; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$output" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null
attached=1

app="$mount_dir/Word Hunter.app"
binary="$app/Contents/MacOS/word-hunter-rustified"
[[ -d "$app" ]] || die "DMG does not contain Word Hunter.app"
[[ -L "$mount_dir/Applications" ]] || die "DMG does not contain the Applications shortcut"
[[ -x "$binary" ]] || die "app bundle does not contain its executable"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wordhunter.app" ]] \
  || die "app bundle identifier is incorrect"
file "$binary" | grep -q 'arm64' || die "app executable is not arm64"
codesign --verify --deep --strict "$app"

log_file="$(mktemp)"
"$binary" >"$log_file" 2>&1 &
app_pid=$!
for _ in {1..5}; do
  sleep 1
  if ! kill -0 "$app_pid" 2>/dev/null; then
    cat "$log_file" >&2
    die "packaged application exited during the smoke test"
  fi
done
kill "$app_pid"
wait "$app_pid" 2>/dev/null || true
rm -f "$log_file"

echo "Validated macOS DMG: $output"
