#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

manifest="${FLATPAK_MANIFEST:-com.wordhunter.app.yml}"
build_dir="${FLATPAK_BUILD_DIR:-build/flatpak}"
repo_dir="${FLATPAK_REPO_DIR:-outputs/flatpak-repo}"
bundle="${FLATPAK_BUNDLE:-outputs/WordHunter.flatpak}"
jobs="${FLATPAK_JOBS:-2}"
artifact_inspector="$root/scripts/inspect-artifact.mjs"

if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "FLATPAK_JOBS must be a positive integer, got: $jobs" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to validate the completed Flatpak bundle." >&2
  exit 1
fi

prepare_repo() {
  if ! command -v ostree >/dev/null 2>&1; then
    return
  fi

  if [[ ! -f "$repo_dir/config" ]]; then
    ostree --repo="$repo_dir" init --mode=archive-z2
  fi

  ostree --repo="$repo_dir" config set core.min-free-space-percent 0
}

install_kde_gtk_theme() {
  local desktop="${XDG_CURRENT_DESKTOP:-} ${DESKTOP_SESSION:-}"
  if [[ "${KDE_FULL_SESSION:-}" != "true" && "$desktop" != *KDE* && "$desktop" != *plasma* ]]; then
    return
  fi

  if flatpak info --user org.gtk.Gtk3theme.Breeze >/dev/null 2>&1 || flatpak info org.gtk.Gtk3theme.Breeze >/dev/null 2>&1; then
    return
  fi

  echo "KDE session detected; installing the Breeze GTK Flatpak theme for better GTK/WebKit styling."
  flatpak --user install -y flathub org.gtk.Gtk3theme.Breeze//3.22
}

if command -v flatpak-builder >/dev/null 2>&1; then
  builder=(flatpak-builder)
elif flatpak info --user org.flatpak.Builder >/dev/null 2>&1 || flatpak info org.flatpak.Builder >/dev/null 2>&1; then
  builder=(flatpak run org.flatpak.Builder)
else
  echo "flatpak-builder is required to build the Flatpak package." >&2
  echo "Install the host flatpak-builder package or the org.flatpak.Builder Flatpak, then rerun this script." >&2
  exit 1
fi

mkdir -p "$(dirname "$bundle")" "$repo_dir"
install_kde_gtk_theme
prepare_repo

"${builder[@]}" \
  --user \
  --disable-rofiles-fuse \
  --force-clean \
  --jobs="$jobs" \
  --install-deps-from=flathub \
  --repo="$repo_dir" \
  "$build_dir" \
  "$manifest"

flatpak build-bundle "$repo_dir" "$bundle" com.wordhunter.app stable
node "$artifact_inspector" flatpak "$bundle"

echo "Flatpak bundle written to $bundle"
echo "Flatpak repo written to $repo_dir"
echo "For local testing with AppStream icons, install with ./scripts/install-flatpak-local.sh"
