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

compare_report() {
  local expected="$1"
  local actual="$2"
  local name="$3"
  python3 - "$expected" "$actual" "$tmp_dir/$name.expected" "$tmp_dir/$name.actual" <<'PY'
import re
import sys
from html import unescape

expected_path, actual_path, normalized_expected, normalized_actual = sys.argv[1:]
for source, destination in (
    (expected_path, normalized_expected),
    (actual_path, normalized_actual),
):
    inventory = []
    license_id = None
    with open(source, encoding="utf-8") as file:
        for line in file:
            heading = re.search(r'<h3 id="([^"]+)">', line)
            if heading:
                license_id = heading.group(1)
                continue
            package = re.search(r'<li><a href="[^"]*">([^<]+)</a></li>', line)
            if license_id and package:
                inventory.append(f"{license_id}\t{unescape(package.group(1))}")
    with open(destination, "w", encoding="utf-8") as file:
        file.write("\n".join(sorted(inventory)) + "\n")
PY
  if ! cmp "$tmp_dir/$name.expected" "$tmp_dir/$name.actual"; then
    diff -u "$tmp_dir/$name.expected" "$tmp_dir/$name.actual" || true
    return 1
  fi
}

if [[ "$mode" == "--check" ]]; then
  compare_report THIRD-PARTY-LICENSES.html "$tmp_dir/main.html" main
  compare_report OCR-THIRD-PARTY-LICENSES.html "$tmp_dir/ocr.html" ocr
  echo "Third-party Rust license reports are up to date."
else
  mv "$tmp_dir/main.html" THIRD-PARTY-LICENSES.html
  mv "$tmp_dir/ocr.html" OCR-THIRD-PARTY-LICENSES.html
  echo "Updated third-party Rust license reports."
fi
