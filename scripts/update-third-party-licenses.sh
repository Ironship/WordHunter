#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mode="${1:---update}"
required_cargo_about="0.9.1"
if [[ "$mode" != "--check" && "$mode" != "--update" ]]; then
  echo "Usage: $0 [--check|--update]" >&2
  exit 2
fi
if ! cargo about --version >/dev/null 2>&1; then
  echo "cargo-about $required_cargo_about is required. Install it with: cargo install cargo-about --version $required_cargo_about --locked --features cli" >&2
  exit 1
fi
actual_cargo_about="$(cargo about --version)"
actual_cargo_about="${actual_cargo_about#cargo-about }"
actual_cargo_about="${actual_cargo_about%% *}"
if [[ "$actual_cargo_about" != "$required_cargo_about" ]]; then
  echo "cargo-about $required_cargo_about is required for reproducible reports; found $actual_cargo_about." >&2
  echo "Install it with: cargo install cargo-about --version $required_cargo_about --locked --features cli --force" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cargo about generate --locked \
  --manifest-path src-tauri/Cargo.toml \
  --config src-tauri/about.toml \
  src-tauri/about.hbs \
  --output-file "$tmp_dir/main.html"
cargo about generate --locked \
  --manifest-path src-tauri/ocr-runner/Cargo.toml \
  --config src-tauri/about.toml \
  src-tauri/about.hbs \
  --output-file "$tmp_dir/ocr.html"

if [[ "$mode" == "--check" ]]; then
  cmp THIRD-PARTY-LICENSES.html "$tmp_dir/main.html"
  cmp OCR-THIRD-PARTY-LICENSES.html "$tmp_dir/ocr.html"
  echo "Third-party Rust license reports are up to date."
else
  mv "$tmp_dir/main.html" THIRD-PARTY-LICENSES.html
  mv "$tmp_dir/ocr.html" OCR-THIRD-PARTY-LICENSES.html
  echo "Updated third-party Rust license reports."
fi
