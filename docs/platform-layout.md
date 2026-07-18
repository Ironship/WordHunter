# Platform source layout

Word Hunter keeps one shared app and adds platform layers only where the OS actually differs.

Active targets in this repository right now:

- Windows desktop
- Linux desktop
- macOS desktop (Apple Silicon)
- Android Pocket

Intel Macs and iOS are intentionally outside the current layout.

## Shared code

- `src/web/` contains the shared HTML, TypeScript, i18n, flags, and base CSS.
- `dist/web/` is the generated, untracked browser runtime embedded by Tauri.
- `src-tauri/src/` contains shared Rust handlers, storage, SRS, tokenization, subtitles, and export logic.
- `scripts/build.bat` is the shared build entrypoint for Windows desktop artifacts, Android APK/AAB builds, and frontend tests. Linux packages use `scripts/build-flatpak.sh`; Apple Silicon DMGs use `scripts/build-macos.sh`.

## Web platform layers

- `src/web/styles.css` is the shared desktop-first stylesheet.
- `src/web/platforms/android-pocket.css` contains Android/Pocket-only layout overrides for `.pocket-mode`.
- `src/web/js/platform.ts` detects Android/Pocket and applies mobile-only UI behavior.

## Native platform layers

- `src-tauri/src/platform/web_app.rs` contains shared Windows/Linux/macOS desktop startup glue.
- `src-tauri/src/platform/android.rs` contains Android startup glue.
- `src-tauri/platforms/android/MainActivity.kt` contains the Android WebView bridge, including the sync folder picker.
- `src-tauri/platforms/android/AndroidManifest.xml` contains the Android manifest template copied into Tauri's generated project.

## Android-only backend replacements

The Android backend shims live in `src-tauri/src/platform/android_backend/`. They keep the APK small and prevent desktop-only features from loading on phones.

- `pdf_ocr.rs`: disables desktop PDF OCR on Pocket.
- `offline_translator.rs`: disables CTranslate2/local model flows on Pocket.
- `tts.rs`: disables desktop Edge TTS on Pocket.
- `popup.rs`: disables desktop dictionary popup endpoints on Pocket.

EPUB import uses the shared Rust ebook parser on every platform. MOBI/AZW still depends on desktop Calibre `ebook-convert`, so Pocket should receive MOBI books through PC sync until a mobile parser exists.

## Config files

- `src-tauri/tauri.conf.json` is the shared Tauri config.
- `src-tauri/tauri.windows.conf.json` is Windows-specific.
- `src-tauri/tauri.macos.conf.json` is the Apple Silicon DMG configuration.
- `src-tauri/tauri.linux-bundle.conf.json` is passed explicitly by the Linux
  package script. Keeping it out of Tauri's automatic platform-config name
  prevents ordinary Rust tests from requiring package resources that are only
  staged during AppImage and DEB builds.
- `src-tauri/tauri.android.conf.json` is Android/Pocket-specific.

## Tests

- `frontend-tests/shared/` contains cross-platform frontend logic tests.
- `frontend-tests/desktop/` contains desktop UI and platform-contract tests.
- `frontend-tests/android/` contains Pocket/Android UI and packaging tests.
- Run all frontend tests with `.\scripts\build.bat test`.
