# Release Validation

## Validation Tiers

Run the repository gate before cutting release artifacts:

```bash
npm ci --ignore-scripts --no-audit --no-fund
./scripts/validate.sh
```

It checks whitespace, CSS and the complete TypeScript frontend, parses tracked
JSON and i18n locales, runs all Node tests,
checks Flatpak Cargo source and third-party license report drift, verifies Rust
formatting, runs both Rust test suites, and runs Clippy for both crates. Clippy
is required by CI and by default locally. A local diagnostic run can explicitly
omit it:

```bash
WORDHUNTER_VALIDATE_CLIPPY=0 ./scripts/validate.sh
```

The license drift check requires the generator version used by CI:

```bash
cargo install cargo-about --version 0.9.1 --locked --features cli
```

Use `WORDHUNTER_VALIDATE_LICENSES=0` only for a local diagnostic run where that
tool cannot be installed. CI sets both validation switches to `1`.

`.github/workflows/validate.yml` runs the repository gate for pull requests and
selected pushes. A separate required job sets up Java, the Android SDK/NDK, the
Android Rust target, and the pinned Tauri CLI, then runs `scripts/build.bat apk`.
This compiles the generated Gradle project, custom `MainActivity.kt`, Android
resources, and Rust library into a real debug APK.

Full release packages are deliberately kept out of the fast pull-request gate.
`.github/workflows/artifact-validation.yml` runs nightly or when manually
dispatched. It rebuilds and validates:

- arm64 Android debug APK and release AAB file lists, ELF architecture, legal
  resources, and the absence of the desktop OCR runtime;
- x86_64 Windows portable ZIP and NSIS contents, native executables, OCR models,
  Syncthing notices, compiler runtime DLLs discovered by the build, and all
  legal reports;
- the x86_64 Flatpak ref, installed file list, native ELF architecture, OCR
  models, Syncthing notices, desktop metadata, and legal reports;
- x86_64 Linux AppImage and DEB installed file trees, native ELF architecture,
  OCR models and runtime, Syncthing integration, canonical desktop and
  AppStream metadata, Debian control fields, executable modes, and legal
  reports.

Every expected CI upload uses `if-no-files-found: error`. The Windows recipe
also fails if 7-Zip is unavailable or cannot read an archive; release archive
inspection is never silently skipped. `scripts/build-flatpak.sh` inspects the
completed bundle before reporting success. Native Linux packages are built on
Ubuntu 22.04, the oldest GitHub-hosted runner used by the release workflow with
WebKitGTK 4.1 development packages. `scripts/build-linux-native.sh` emits
`WordHunter-<version>-x86_64.AppImage` and
`word-hunter_<version>_amd64.deb`; the workflow reinspects both files before
uploading them. All AppImage assembly tools are staged under
`src-tauri/target/.tauri` from checksum-verified downloads, including scripts
from the exact pinned Tauri CLI revision.

A separate Ubuntu 22.04 container downloads the completed workflow artifact
without inheriting the build job's development packages. It validates the
desktop and AppStream files with upstream tools, rejects unresolved ELF
dependencies, runs the OCR helper and Syncthing, and starts the AppImage under
Xvfb before installing the DEB. It then runs Lintian, installs the DEB and its
declared system Syncthing dependency, repeats the sidecar and GUI smoke tests,
and removes the package. The AppImage contains its own Syncthing executable;
the DEB deliberately does not overwrite `/usr/bin/syncthing`.

Lintian errors remain release-blocking. The DEB ships three narrowly scoped
overrides for `freetype`, `lcms2`, and `openjpeg` detected inside the pinned
upstream PDFium shared library. The matching PDFium build and checksum are part
of the release recipe because Ubuntu 22.04 does not provide a compatible system
PDFium library. Missing package dependencies, changelog metadata, and
unstripped Word Hunter binaries are fixed by the recipe rather than overridden.

The workflow always uploads validated files as workflow artifacts. A manual
dispatch may additionally provide an existing draft `release_tag`; after every
platform job succeeds, a final GitHub-hosted job attaches all seven validated
files to that draft. This keeps release binaries off the maintainer's local
machine. The draft must target the exact commit selected for the workflow run.
Scheduled runs do not attach or replace assets. Publishing the draft does not
rebuild the same artifacts a second time.

## Distribution Package Validation

Store-specific recipes have independent GitHub Actions checks so their tools
and target operating systems stay outside the normal repository gate:

- `.github/workflows/package-store-validation.yml` validates the Chocolatey
  package lifecycle on a disposable Windows runner;
- `.github/workflows/snap-validation.yml` builds a strict Snap from the pinned
  stable DEB, inspects its payload, installs it only on the disposable Ubuntu
  runner, and performs a GUI smoke test; and
- `.github/workflows/aur-validation.yml` builds `wordhunter-bin` from the pinned
  stable AppImage in an Arch Linux container, inspects and installs the package,
  exercises its bundled tools and GUI, and removes it again.

The Snap and AUR workflows are validation-only. They do not read store
credentials, reserve package names, publish releases, or claim that Word Hunter
is available from either catalog. Store publication remains a separate manual,
account-gated maintainer step.

## Android Version Code

Android builds derive `versionName` and `versionCode` from
`src-tauri/tauri.conf.json`. Accepted versions are `MAJOR.MINOR.PATCH` and
`MAJOR.MINOR.PATCH-rc.N`:

- `versionName` keeps the complete version, including `-rc.N`.
- The base is `MAJOR * 1000000 + MINOR * 1000 + PATCH`.
- RC `versionCode` is `base * 100 + N`, where `N` is 1 through 98.
- Stable `versionCode` is `base * 100 + 99`, so the final build supersedes
  every release candidate for the same version.

Keep `MINOR` and `PATCH` below 1000. The build rejects values outside Android's
positive signed 32-bit application-version range. Do not use SemVer build
metadata for releases because Tauri's direct Android build does not map it to a
distinct version code.

Prerelease APK/AAB files are test artifacts and must not be submitted to a
stable store track. The GitHub update checker uses the stable-only
`releases/latest` endpoint, so publishing a GitHub prerelease does not prompt
users running a stable Word Hunter build.

The nightly/release validation AAB is unsigned unless `WH_ANDROID_*` signing
variables are supplied to the Windows recipe. Google Play publication still
requires the protected upload keystore and a `scripts/build.bat play` run on a
trusted Windows release environment.

## Flatpak Cargo Sources

`flatpak/cargo-sources.json` is generated from both Rust lockfiles. After
changing `src-tauri/Cargo.lock` or `src-tauri/ocr-runner/Cargo.lock`, refresh it:

```bash
./scripts/update-flatpak-cargo-sources.sh
```

Review drift without rewriting the file:

```bash
./scripts/update-flatpak-cargo-sources.sh --check
```

The Flatpak manifest keeps remote archives versioned or commit-pinned with
SHA-256 checksums and limits the package to x86_64. Artifact validation requires
`flatpak`, `ostree`, and Node.js in addition to `flatpak-builder`.

## Third-Party Licenses

Release packages include Word Hunter's `LICENSE`, the native component summary
in `THIRD-PARTY-NOTICES.md`, and complete locked Rust dependency reports. After
either lockfile changes, regenerate and review them:

```bash
./scripts/update-third-party-licenses.sh --update
./scripts/update-third-party-licenses.sh --check
```

Generation is pinned to `cargo-about 0.9.1`; another generator version fails
instead of introducing formatting-only drift.

## Platform Constraints

Static tests validate recipes and policy, but they do not pretend to validate a
binary that was not built. Windows PE/NSIS validation runs on Windows, Android
Gradle compilation runs with the Android toolchain, and Flatpak OSTree file-list
validation runs on Linux. AppImage and DEB validation also runs on Linux,
extracts each completed package, and starts both GUI payloads under Xvfb on a
clean runtime container. Installer launch
behavior, WebView2 availability, Android device behavior, Google Play
signing/acceptance, and interactive Flatpak/AppImage/DEB desktop integration
remain platform or store tests and require release hardware/accounts.
