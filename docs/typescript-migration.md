# TypeScript migration checklist

Scope: the browser application under `src/web`. Rust remains the native host and
is not part of this migration. Test runners and build helpers may remain
JavaScript because they are not shipped as browser runtime code.

The compiler rejects implicit `any`. `strictNullChecks` remains disabled for
this release because the legacy DOM cache contains platform-dependent optional
elements; enabling it is tracked as a separate hardening step rather than being
hidden behind local assertions.

## Build contract

- [x] Keep all browser source modules as `.ts` under `src/web`.
- [x] Keep browser import specifiers ending in `.js`; TypeScript emits matching
      browser paths without a bundler.
- [x] Compile with the repository-pinned TypeScript version into a clean
      `dist/web` directory.
- [x] Copy HTML, CSS, translations, starter books, flags, icons, and templates
      from `src/web` to `dist/web` without modifying source files.
- [x] Point Tauri and the embedded HTTP router only at `dist/web`.
- [x] Build the frontend before Windows, Android, Flatpak, and Rust validation.
- [x] Run frontend behavior tests against `dist/web`, not TypeScript source.
- [x] Keep `dist/web` generated and untracked.

## Runtime migration

- [x] Rename all 87 browser runtime modules from `.js` to `.ts`.
- [x] Define shared state, preference, vocabulary, text, bridge, and platform
      boundary types.
- [x] Type DOM caches and delegated browser events without `@ts-ignore` or
      `@ts-nocheck`.
- [x] Type worker messages, canvas/chart data, PDF.js integration, translation
      responses, Android bridge calls, and YouGlish integration.
- [x] Preserve all existing dynamic import paths and worker URLs in emitted JS.
- [x] Confirm that no `.js` runtime source remains under `src/web`.

## Selected-word panel

- [x] Store a normalized ordered list of panel item IDs in preferences.
- [x] Expose an accessible visibility checkbox and Up/Down ordering controls for
      each configurable item.
- [x] Support status controls, smart suggestion, translation/review, note,
      image, example/context, dictionary, speech, YouGlish, copy, edit, and
      remove actions.
- [x] Keep the word heading and Pocket close button structural and always
      available.
- [x] Preserve direct keyboard actions when their visual buttons are hidden;
      do not render hidden focus targets for editable fields.
- [x] Remove the duplicated Pocket dictionary action.
- [x] Position the Pocket sheet between the top safe area and bottom Reader
      toolbar so the action panel starts higher and remains scrollable.
- [x] Normalize malformed, duplicate, old, and partial persisted layouts.
- [x] Add matching strings to all locales and preserve locale key parity.

## Verification

- [x] TypeScript emits the complete frontend with no diagnostics.
- [x] Stylelint and JSON/i18n validation pass.
- [x] Shared, desktop, and Android frontend suites pass against `dist/web`.
- [ ] Cargo formatting, tests, and clippy continue to pass.
- [x] Windows, Android, and Flatpak release recipes consume `dist/web`.
- [x] Independent review confirms feature parity and no source/runtime drift.
