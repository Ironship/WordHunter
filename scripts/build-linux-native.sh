#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

cache_dir="${WORDHUNTER_LINUX_CACHE_DIR:-$root/build/linux-native-cache}"
outputs_dir="${WORDHUNTER_OUTPUTS_DIR:-$root/outputs}"
ctranslate2_release="4.6.0"

ort_url="https://cdn.pyke.io/0/pyke:ort-rs/ms@1.22.0/x86_64-unknown-linux-gnu+wgpu.tgz"
ort_sha256="d766b62a8419124d242bb02a0ab1d2407b86c39011fec6214d83d5ac304d5593"
pdfium_url="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7920/pdfium-linux-x64.tgz"
pdfium_sha256="49ab3afbd4e6c1e284b5f2898129c8bb8a10fd785c1c5392c8c1fc70242f9ced"
models_url="https://github.com/mg-chao/paddle-ocr-rs/releases/download/onnx_models/Paddle.OCR.V5.zip"
models_sha256="2fa4055b10dc4e9c1433444fe29f8d5acca2fccc0a0e86b3313caa5cc9e56b7a"
syncthing_url="https://github.com/syncthing/syncthing/releases/download/v2.1.0/syncthing-linux-amd64-v2.1.0.tar.gz"
syncthing_sha256="624c2f3303c9ed7d6f27a98ad9767ab95a7b5e453c3c5e17ce8a60f166e47011"
apprun_url="https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64"
apprun_sha256="f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f"
linuxdeploy_url="https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage"
linuxdeploy_sha256="e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef"
linuxdeploy_gtk_url="https://raw.githubusercontent.com/tauri-apps/tauri/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh"
linuxdeploy_gtk_sha256="06a56df39e65806170ebae570e593ea14ad9aecf97f668694c343f461482b4c4"
linuxdeploy_gstreamer_url="https://raw.githubusercontent.com/tauri-apps/tauri/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gstreamer.sh"
linuxdeploy_gstreamer_sha256="2a15ce9da8de6e20159e1ab27861a7a5ef8758c81a6278ba4ab30cefa1d74c9f"
linuxdeploy_appimage_url="https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage"
linuxdeploy_appimage_sha256="992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3"

die() {
  echo "error: $*" >&2
  exit 1
}

note() {
  echo "==> $*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

for command_name in cargo curl find gzip install npm node sha256sum strip tar unzip; do
  require_command "$command_name"
done

case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) die "the native Linux packages currently support x86_64 runners only" ;;
esac

version="$(node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")); if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(c.version)) process.exit(1); process.stdout.write(c.version);')" \
  || die "src-tauri/tauri.conf.json does not contain a valid package version"

mkdir -p "$cache_dir" "$outputs_dir"

download_checked() {
  local filename="$1"
  local url="$2"
  local expected_sha256="$3"
  local destination="$cache_dir/$filename"
  local actual_sha256=""

  if [[ -f "$destination" ]]; then
    actual_sha256="$(sha256sum "$destination" | awk '{print $1}')"
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
      note "Discarding cached $filename with an invalid SHA-256"
      rm -f "$destination"
    fi
  fi

  if [[ ! -f "$destination" ]]; then
    note "Downloading $filename"
    curl \
      --fail \
      --location \
      --retry 3 \
      --retry-all-errors \
      --show-error \
      --silent \
      --output "$destination.part" \
      "$url"
    mv "$destination.part" "$destination"
  fi

  actual_sha256="$(sha256sum "$destination" | awk '{print $1}')"
  [[ "$actual_sha256" == "$expected_sha256" ]] \
    || die "SHA-256 mismatch for $filename (expected $expected_sha256, got $actual_sha256)"

  printf '%s\n' "$destination"
}

extract_tgz() {
  local archive="$1"
  local destination="$2"
  local strip_components="${3:-0}"

  rm -rf "$destination"
  mkdir -p "$destination"
  tar \
    --extract \
    --gzip \
    --file "$archive" \
    --directory "$destination" \
    --no-same-owner \
    --strip-components "$strip_components"
}

extract_zip() {
  local archive="$1"
  local destination="$2"

  rm -rf "$destination"
  mkdir -p "$destination"
  unzip -q "$archive" -d "$destination"
}

copy_archive_source() {
  local filename="$1"
  local url="$2"
  local sha256="$3"
  local destination="$4"
  local strip_components="${5:-1}"
  local archive

  archive="$(download_checked "$filename" "$url" "$sha256")"
  extract_tgz "$archive" "$destination" "$strip_components"
}

prepare_tauri_appimage_tools() {
  local tools_dir="$root/src-tauri/target/.tauri"
  local apprun linuxdeploy gtk_plugin gstreamer_plugin appimage_plugin

  apprun="$(download_checked "AppRun-x86_64" "$apprun_url" "$apprun_sha256")"
  linuxdeploy="$(download_checked "linuxdeploy-x86_64.AppImage" "$linuxdeploy_url" "$linuxdeploy_sha256")"
  gtk_plugin="$(download_checked "linuxdeploy-plugin-gtk-tauri-cli-2.11.4.sh" "$linuxdeploy_gtk_url" "$linuxdeploy_gtk_sha256")"
  gstreamer_plugin="$(download_checked "linuxdeploy-plugin-gstreamer-tauri-cli-2.11.4.sh" "$linuxdeploy_gstreamer_url" "$linuxdeploy_gstreamer_sha256")"
  appimage_plugin="$(download_checked "linuxdeploy-plugin-appimage-1-alpha-20250213-1-x86_64.AppImage" "$linuxdeploy_appimage_url" "$linuxdeploy_appimage_sha256")"

  # Tauri deliberately patches its working linuxdeploy copy with `dd`, so the
  # verified downloads stay in the immutable cache and a fresh copy is staged
  # for every build.
  rm -rf "$tools_dir"
  mkdir -p "$tools_dir"
  install -m 0755 "$apprun" "$tools_dir/AppRun-x86_64"
  install -m 0755 "$linuxdeploy" "$tools_dir/linuxdeploy-x86_64.AppImage"
  install -m 0755 "$gtk_plugin" "$tools_dir/linuxdeploy-plugin-gtk.sh"
  install -m 0755 "$gstreamer_plugin" "$tools_dir/linuxdeploy-plugin-gstreamer.sh"
  install -m 0755 "$appimage_plugin" "$tools_dir/linuxdeploy-plugin-appimage.AppImage"
  gzip -9 -n -c "$root/packaging/linux/debian-changelog" \
    > "$tools_dir/word-hunter-changelog.gz"
}

prepare_ctranslate2_sources() {
  local destination="$root/src-tauri/target/release/CTranslate2-$ctranslate2_release"

  note "Preparing pinned CTranslate2 $ctranslate2_release sources"
  copy_archive_source \
    "ctranslate2-v4.6.0.tar.gz" \
    "https://github.com/OpenNMT/CTranslate2/archive/refs/tags/v4.6.0.tar.gz" \
    "9421d846668573466ceb713b27f71fb16fed8486ed7bdb654583c48c3c20621b" \
    "$destination"
  copy_archive_source \
    "cpu_features-8a494eb1.tar.gz" \
    "https://github.com/google/cpu_features/archive/8a494eb1e158ec2050e5f699a504fbc9b896a43b.tar.gz" \
    "9b2019dae7608630ab985129a5c3263fc788e4f82e26965a8d8c33b8c035802e" \
    "$destination/third_party/cpu_features"
  copy_archive_source \
    "cutlass-bbe579a9.tar.gz" \
    "https://github.com/NVIDIA/cutlass/archive/bbe579a9e3beb6ea6626d9227ec32d0dae119a49.tar.gz" \
    "9fa1da6be3d2d9207b801d5768cbced59c202444a8c84b82325b0670f47f9d48" \
    "$destination/third_party/cutlass"
  copy_archive_source \
    "cxxopts-c74846a8.tar.gz" \
    "https://github.com/jarro2783/cxxopts/archive/c74846a891b3cc3bfa992d588b1295f528d43039.tar.gz" \
    "29b618401f6e29ee5a21208c5cf4d8b17e55814cc220e0ada9a798239f1944e3" \
    "$destination/third_party/cxxopts"
  copy_archive_source \
    "googletest-f8d7d77c.tar.gz" \
    "https://github.com/google/googletest/archive/f8d7d77c06936315286eb55f8de22cd23c188571.tar.gz" \
    "7ff5db23de232a39cbb5c9f5143c355885e30ac596161a6b9fc50c4538bfbf01" \
    "$destination/third_party/googletest"
  copy_archive_source \
    "ruy-363f2522.tar.gz" \
    "https://github.com/google/ruy/archive/363f252289fb7a1fba1703d99196524698cb884d.tar.gz" \
    "3c2181c9134896784d5d0494e2638c43127de4da2ddf81b3a64c06311fb17432" \
    "$destination/third_party/ruy"
  copy_archive_source \
    "cpuinfo-082deffc.tar.gz" \
    "https://github.com/pytorch/cpuinfo/archive/082deffc80ce517f81dc2f3aebe6ba671fcd09c9.tar.gz" \
    "4379348ec3127b37e854a0a66f85ea1d3c606e5f3a6dce235dc9c69ce663c026" \
    "$destination/third_party/ruy/third_party/cpuinfo"
  copy_archive_source \
    "googletest-6c58c11d.tar.gz" \
    "https://github.com/google/googletest/archive/6c58c11d5497b6ee1df3cb400ce30deb72fc28c0.tar.gz" \
    "b4a7109b1a4fa078c23012078ad5bc273af24a10f8bfcaecc6111839fceeb010" \
    "$destination/third_party/ruy/third_party/googletest"
  copy_archive_source \
    "spdlog-76fb40d9.tar.gz" \
    "https://github.com/gabime/spdlog/archive/76fb40d95455f249bd70824ecfcae7a8f0930fa3.tar.gz" \
    "4530d53b86d45228a5b8982a8f4fe7d95d3ba8e1944858d3f663732c7e949cb7" \
    "$destination/third_party/spdlog"
  copy_archive_source \
    "thrust-d997cd37.tar.gz" \
    "https://github.com/NVIDIA/thrust/archive/d997cd37a95b0fa2f1a0cd4697fd1188a842fbc8.tar.gz" \
    "940e45a615f690f9f4adabae60c9da1956f5759b2e1ba58021c0a82897726ae0" \
    "$destination/third_party/thrust"

  touch "$destination/submodules_downloaded"
}

prepare_native_runtime() {
  local ort_archive pdfium_archive models_archive syncthing_archive
  local ort_dir="$root/src-tauri/target/linux-native-onnxruntime"
  local pdfium_dir="$root/src-tauri/target/linux-native-pdfium"
  local models_dir="$root/src-tauri/target/linux-native-ocr-models"
  local syncthing_dir="$root/src-tauri/target/linux-native-syncthing"
  local runtime_bin="$root/src-tauri/ocr-runtime/bin"
  local runtime_models="$root/src-tauri/ocr-runtime/models"
  local bundle_syncthing="$root/src-tauri/syncthing"
  local pdfium_library model_count webgpu_library

  ort_archive="$(download_checked "ort-1.22.0-linux-x86_64-wgpu.tgz" "$ort_url" "$ort_sha256")"
  pdfium_archive="$(download_checked "pdfium-chromium-7920-linux-x64.tgz" "$pdfium_url" "$pdfium_sha256")"
  models_archive="$(download_checked "Paddle.OCR.V5.zip" "$models_url" "$models_sha256")"
  syncthing_archive="$(download_checked "syncthing-linux-amd64-v2.1.0.tar.gz" "$syncthing_url" "$syncthing_sha256")"

  note "Extracting OCR and Syncthing runtime inputs"
  extract_tgz "$ort_archive" "$ort_dir" 1
  extract_tgz "$pdfium_archive" "$pdfium_dir"
  extract_zip "$models_archive" "$models_dir"
  extract_tgz "$syncthing_archive" "$syncthing_dir" 1

  [[ -d "$ort_dir/lib" ]] || die "ONNX Runtime archive does not contain lib/"
  pdfium_library="$(find "$pdfium_dir" -type f -name 'libpdfium.so' -print -quit)"
  [[ -n "$pdfium_library" ]] || die "PDFium archive does not contain libpdfium.so"
  [[ -x "$syncthing_dir/syncthing" ]] || die "Syncthing archive does not contain an executable syncthing binary"
  [[ -f "$syncthing_dir/LICENSE.txt" ]] || die "Syncthing archive does not contain LICENSE.txt"
  [[ -f "$syncthing_dir/AUTHORS.txt" ]] || die "Syncthing archive does not contain AUTHORS.txt"

  find "$runtime_bin" -mindepth 1 ! -name .gitkeep -delete
  find "$runtime_models" -mindepth 1 ! -name .gitkeep -delete
  find "$bundle_syncthing" -mindepth 1 ! -name .gitkeep -delete

  cp "$pdfium_library" "$runtime_bin/libpdfium.so"
  webgpu_library="$(find -L "$ort_dir/lib" -maxdepth 1 -type f -name 'libwebgpu_dawn.so' -print -quit)"
  [[ -n "$webgpu_library" ]] || die "ONNX Runtime archive does not contain libwebgpu_dawn.so"
  cp -L "$webgpu_library" "$runtime_bin/libwebgpu_dawn.so"
  strip --strip-unneeded "$runtime_bin/libpdfium.so" "$runtime_bin/libwebgpu_dawn.so"

  while IFS= read -r -d '' model; do
    cp "$model" "$runtime_models/$(basename "$model")"
  done < <(find "$models_dir" -type f \( -name '*.onnx' -o -name '*.txt' \) -print0)

  model_count="$(find "$runtime_models" -maxdepth 1 -type f -name '*.onnx' | wc -l)"
  [[ "$model_count" -ge 3 ]] || die "PaddleOCR archive yielded fewer than three ONNX models"
  cp "$syncthing_dir/syncthing" "$bundle_syncthing/syncthing"
  cp "$syncthing_dir/LICENSE.txt" "$bundle_syncthing/SYNCTHING-LICENSE.txt"
  cp "$syncthing_dir/AUTHORS.txt" "$bundle_syncthing/SYNCTHING-AUTHORS.txt"
  chmod 0755 "$bundle_syncthing/syncthing"

  printf '%s\n' "$ort_dir"
}

prepare_ctranslate2_sources
prepare_tauri_appimage_tools
ort_dir="$(prepare_native_runtime)"

if [[ ! -f node_modules/typescript/bin/tsc ]]; then
  note "Restoring frontend dependencies"
  npm ci --ignore-scripts --no-audit --no-fund
fi
note "Building frontend"
npm run build:frontend

note "Building native PaddleOCR runner"
ocr_rustflags="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=-Wl,-rpath,\$ORIGIN"
ORT_LIB_LOCATION="$ort_dir" \
RUSTFLAGS="$ocr_rustflags" \
cargo build \
  --locked \
  --release \
  --manifest-path "$root/src-tauri/ocr-runner/Cargo.toml"

ocr_runner="$root/src-tauri/ocr-runner/target/release/wordhunter-paddleocr"
[[ -x "$ocr_runner" ]] || die "OCR runner build did not produce $ocr_runner"
strip --strip-unneeded "$ocr_runner"
cp "$ocr_runner" "$root/src-tauri/ocr-runtime/bin/wordhunter-paddleocr"
chmod 0755 "$root/src-tauri/ocr-runtime/bin/wordhunter-paddleocr"

note "Building Tauri AppImage and Debian packages"
rm -rf \
  "$root/src-tauri/target/release/bundle/appimage" \
  "$root/src-tauri/target/release/bundle/deb"

CTRANSLATE2_RELEASE="$ctranslate2_release" \
CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-2}" \
CARGO_PROFILE_RELEASE_STRIP=symbols \
cargo tauri build \
  --bundles appimage,deb \
  --config "$root/src-tauri/tauri.linux.conf.json"

single_artifact() {
  local directory="$1"
  local pattern="$2"
  local -a matches=()

  [[ -d "$directory" ]] || die "bundle directory was not created: $directory"
  mapfile -d '' matches < <(find "$directory" -maxdepth 1 -type f -name "$pattern" -print0)
  [[ "${#matches[@]}" -eq 1 ]] \
    || die "expected exactly one $pattern artifact in $directory, found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

appimage_source="$(single_artifact "$root/src-tauri/target/release/bundle/appimage" '*.AppImage')"
deb_source="$(single_artifact "$root/src-tauri/target/release/bundle/deb" '*.deb')"
appimage_output="$outputs_dir/WordHunter-$version-x86_64.AppImage"
deb_output="$outputs_dir/word-hunter_${version}_amd64.deb"

cp "$appimage_source" "$appimage_output"
cp "$deb_source" "$deb_output"
chmod 0755 "$appimage_output"

[[ -s "$appimage_output" ]] || die "AppImage output is empty"
[[ -s "$deb_output" ]] || die "Debian package output is empty"

note "Linux packages written to:"
echo "$appimage_output"
echo "$deb_output"
