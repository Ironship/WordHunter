#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

generator="$tmpdir/flatpak-cargo-generator.py"
curl -fsSL \
  https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py \
  -o "$generator"

if command -v uv >/dev/null 2>&1; then
  uv run "$generator" src-tauri/Cargo.lock -o flatpak/cargo-sources.json
else
  python3 "$generator" src-tauri/Cargo.lock -o flatpak/cargo-sources.json
fi
