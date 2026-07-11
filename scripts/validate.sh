#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

local_node_dir="${WORDHUNTER_LOCAL_NODE_DIR:-}"
if [[ -n "$local_node_dir" && -x "$local_node_dir/node" ]]; then
  export PATH="$local_node_dir:$PATH"
fi
export PATH="$HOME/.cargo/bin:$PATH"

run() {
  echo
  echo "==> $*"
  "$@"
}

if ! command -v node >/dev/null 2>&1; then
  echo "node was not found. Install Node.js 22+ or set WORDHUNTER_LOCAL_NODE_DIR." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. Install Rust 1.88+ with rustup." >&2
  exit 1
fi

run git diff --check
run node scripts/validate-json-i18n.mjs
run node --experimental-vm-modules --test frontend-tests/shared/*.test.js frontend-tests/desktop/*.test.js frontend-tests/android/*.test.js
run ./scripts/update-flatpak-cargo-sources.sh --check
if [[ "${WORDHUNTER_VALIDATE_LICENSES:-1}" != "0" ]]; then
  run ./scripts/update-third-party-licenses.sh --check
else
  echo
  echo "==> third-party license drift check disabled by WORDHUNTER_VALIDATE_LICENSES=0"
fi
run cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
run cargo fmt --manifest-path src-tauri/ocr-runner/Cargo.toml --all -- --check
run cargo test --locked --manifest-path src-tauri/Cargo.toml
run cargo test --locked --manifest-path src-tauri/ocr-runner/Cargo.toml

if [[ "${WORDHUNTER_VALIDATE_CLIPPY:-1}" != "0" ]]; then
  if ! cargo clippy --version >/dev/null 2>&1; then
    echo "cargo clippy is required. Install it with: rustup component add clippy" >&2
    exit 1
  fi
  run cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets
  run cargo clippy --locked --manifest-path src-tauri/ocr-runner/Cargo.toml --all-targets
else
  echo
  echo "==> cargo clippy disabled by WORDHUNTER_VALIDATE_CLIPPY=0"
fi

echo
echo "Validation complete."
