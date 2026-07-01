# Word Hunter Pocket Port

## Plan

1. Keep one shared web app and one shared Rust core.
2. Put platform-only Tauri config in `src-tauri/tauri.{windows,linux,android}.conf.json`.
3. Put platform-only Rust startup code in `src-tauri/src/platform/`.
4. Remove Android builds from heavyweight desktop code paths before generating APKs.
5. Add the Pocket UI mode inside the existing frontend instead of copying screens.
6. Build desktop artifacts and Android APKs from `build.bat`.

## Platform Split

See `docs/platform-layout.md` for the current file map.

- `src/web/`: shared HTML, CSS, and JavaScript.
- `src/web/platforms/android-pocket.css`: Android/Pocket-only CSS overrides.
- `src-tauri/src/`: shared Rust backend and domain logic.
- `src-tauri/src/platform/`: platform startup and OS-specific bridge decisions.
- `src-tauri/src/platform/android_backend/`: lightweight Android replacements for desktop-only backend APIs.
- `src-tauri/platforms/android/`: Android native template files copied into Tauri's generated project.
- `src-tauri/tauri.windows.conf.json`: Windows installer settings.
- `src-tauri/tauri.linux.conf.json`: Linux bundle settings.
- `src-tauri/tauri.android.conf.json`: Pocket app metadata and Android SDK floor.

## Android Scope

Pocket starts with reader, vocabulary, flashcards, charts, Project Gutenberg discovery, txt/json/EPUB import, native Android TTS, and file-sync friendly storage. OCR, PDF, MOBI/AZW conversion, and local CTranslate2 stay desktop-only until a mobile-native engine exists.
