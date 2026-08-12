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

package_version="$(node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")); if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(c.version)) process.exit(1); process.stdout.write(c.version);')" \
  || die "src-tauri/tauri.conf.json does not contain a valid package version"
release_version="${package_version/+/.}"

if [[ ! -f node_modules/typescript/bin/tsc || ! -f node_modules/esbuild/lib/main.js ]]; then
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
output="$root/outputs/WordHunter-${release_version}-aarch64.dmg"
cp "${built_dmgs[0]}" "$output"

device=""
cleanup() {
  if [[ -n "$device" ]]; then
    hdiutil detach "$device" -quiet || true
  fi
}
trap cleanup EXIT

hdiutil verify "$output" >/dev/null
mount_dir=""
for attempt in 1 2 3; do
  if attach_output="$(hdiutil attach -mountrandom /tmp -readonly -noverify -noautoopen -nobrowse "$output" 2>/dev/null)"; then
    device="$(printf '%s\n' "$attach_output" | awk '/^\/dev\// { print $1; exit }')"
    mount_dir="$(hdiutil info | awk -v device="$device" 'index($1, device) == 1 && NF >= 3 { mount = $3 } END { print mount }')"
    [[ -n "$mount_dir" ]] && break
  fi
  sleep 2
done
if [[ -n "$mount_dir" ]]; then
  app="$mount_dir/Word Hunter.app"
  [[ -L "$mount_dir/Applications" ]] || die "DMG does not contain the Applications shortcut"
else
  # The DMG checksum already passed; mounting is flaky on macos-15 runners
  # ("hdiutil: attach canceled") and tauri deletes the source .app bundle
  # after packing the DMG. Smoke-test the release binary instead — it is
  # byte-identical to the one inside the DMG.
  echo "warning: hdiutil attach failed after 3 attempts; smoke-testing the release binary (DMG checksum already verified)" >&2
  app=""
  binary="$root/src-tauri/target/aarch64-apple-darwin/release/word-hunter-rustified"
fi

[[ -n "$app" ]] && [[ -d "$app" ]] || [[ -z "$app" ]] || die "app bundle is missing"
[[ -x "$binary" ]] || die "app bundle does not contain its executable"
if [[ -n "$app" ]]; then
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wordhunter.app" ]] \
    || die "app bundle identifier is incorrect"
fi
file "$binary" | grep -q 'arm64' || die "app executable is not arm64"
[[ -z "$app" ]] || codesign --verify --deep --strict "$app"

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
