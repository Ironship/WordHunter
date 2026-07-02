#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

repo_dir="${FLATPAK_REPO_DIR:-outputs/flatpak-repo}"
remote="${FLATPAK_REMOTE:-wordhunter-local}"
app_id="${FLATPAK_APP_ID:-com.wordhunter.app}"

if [[ ! -d "$repo_dir/objects" ]]; then
  echo "Flatpak repo was not found at $repo_dir." >&2
  echo "Run ./scripts/build-flatpak.sh first." >&2
  exit 1
fi

repo_uri="file://$(realpath "$repo_dir")"

if flatpak remotes --user --columns=name | grep -Fxq "$remote"; then
  flatpak --user remote-modify --url="$repo_uri" --no-gpg-verify "$remote"
else
  flatpak --user remote-add --no-gpg-verify "$remote" "$repo_uri"
fi

flatpak --user update --appstream -y "$remote" || true
flatpak --user install -y --reinstall "$remote" "$app_id"

echo "Installed $app_id from $remote"
