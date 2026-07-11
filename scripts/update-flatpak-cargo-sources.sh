#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mode="update"
if [[ "${1:-}" == "--check" ]]; then
  mode="check"
elif [[ "${1:-}" == "--update" || "${1:-}" == "" ]]; then
  mode="update"
else
  echo "Usage: $0 [--check|--update]" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

generator="$tmpdir/flatpak-cargo-generator.py"
curl -fsSL \
  https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py \
  -o "$generator"

generate_sources() {
  local lockfile="$1"
  local output="$2"

  if command -v uv >/dev/null 2>&1; then
    uv run "$generator" "$lockfile" -o "$output"
  else
    python3 "$generator" "$lockfile" -o "$output"
  fi
}

ensure_lockfile() {
  local manifest="$1"
  local lockfile="$2"

  if [[ -f "$lockfile" ]]; then
    return
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "$lockfile is missing and cargo is required to generate it." >&2
    exit 1
  fi

  echo "$lockfile is missing; generating it from $manifest."
  cargo generate-lockfile --manifest-path "$manifest"
}

main_sources="$tmpdir/cargo-sources-main.json"
ocr_sources="$tmpdir/cargo-sources-ocr-runner.json"
merged_sources="$tmpdir/cargo-sources.json"

ensure_lockfile src-tauri/ocr-runner/Cargo.toml src-tauri/ocr-runner/Cargo.lock
generate_sources src-tauri/Cargo.lock "$main_sources"
generate_sources src-tauri/ocr-runner/Cargo.lock "$ocr_sources"

python3 - "$main_sources" "$ocr_sources" "$merged_sources" <<'PY'
import json
import sys

main_path, ocr_path, output_path = sys.argv[1:]
with open(main_path, encoding="utf-8") as f:
    sources = json.load(f)
with open(ocr_path, encoding="utf-8") as f:
    sources.extend(json.load(f))


def is_cargo_config(item):
    return (
        item.get("type") == "inline"
        and item.get("dest") == "cargo"
        and item.get("dest-filename") == "config"
    )


def key(item):
    return (
        item.get("type", ""),
        item.get("dest", ""),
        item.get("dest-filename", ""),
        item.get("url", ""),
        item.get("sha256", ""),
        item.get("contents", ""),
    )


merged = []
seen = set()
cargo_config = None
for item in sources:
    if is_cargo_config(item):
        if cargo_config is None:
            cargo_config = item
        continue
    source_key = key(item)
    if source_key in seen:
        continue
    seen.add(source_key)
    merged.append(item)

if cargo_config is not None:
    merged.append(cargo_config)

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(merged, f, indent=4)
    f.write("\n")
PY

if [[ "$mode" == "check" ]]; then
  if ! diff -u flatpak/cargo-sources.json "$merged_sources"; then
    echo
    echo "flatpak/cargo-sources.json is out of date." >&2
    echo "Run ./scripts/update-flatpak-cargo-sources.sh and commit the result." >&2
    exit 1
  fi
  echo "flatpak/cargo-sources.json is up to date."
else
  cp "$merged_sources" flatpak/cargo-sources.json
  echo "Updated flatpak/cargo-sources.json."
fi
