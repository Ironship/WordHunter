# Word Hunter 0.2.7.5

## Release Notes

### New Features

- **Library archive** — archive and unarchive books from the library. New status filter (Active / Archived / All) in the library toolbar. Archived books are dimmed and tagged. Archive state is profile-scoped.
- **Vocabulary filtered by source text** — new "Word source" dropdown in the vocabulary view filters words to only those that appear in a selected text. Uses a tokenization-based index (`text-vocab.js`) that supports single words and multi-word phrases.
- **Reader → vocabulary shortcut** — "Słówka" button in the reader toolbar jumps to the vocabulary view pre-filtered to the current text.
- **Vocabulary export (TXT / Anki TSV)** — export buttons in the vocabulary toolbar. Exports respect current search query, status filters, and text source filter. Anki export includes word, translation, and first example/note as TSV columns. TXT exports one word per line. Files are saved via the native save dialog with auto-generated names (`wordhunter-{source}-{type}-{date}.txt/.tsv`).
- **Last-read book resume** — pressing the reader nav button or `R` shortcut reopens the last-read book for the current learning language. State persists across sessions via `lastReadTextIds` in preferences.
- **Native save dialog: .txt support** — `webview_window.py` now includes a "Text (*.txt)" filter option alongside JSON and TSV.
- **Auto-TTS on word focus** — new reader setting reads the focused/selected word automatically without pressing the TTS shortcut. Manual Space shortcut still works.

### UI & Layout

- New CSS classes for library filter fields (`library-search-field`, `library-level-field`, `library-status-field`, `library-sort-field`) for consistent sizing.
- New `.vocab-export-actions` grid layout for export buttons.
- `.book-card.archived` style with reduced opacity.
- New SVG icons: `archive`, `unarchive`, `fileText`, `cards`.

### i18n

- Added ~30 new strings across all 9 languages (pl, en, de, es, fr, it, ja, ru, uk) for archive, export, text source, vocab filtering, and related toast messages.

### State & Data Model

- `archivedBookIds[]` on root state and per-profile; persisted and migrated.
- `filters.libraryArchive` — current library archive filter (`active` | `archived` | `all`).
- `filters.vocabTextId` — current vocabulary text source filter (text ID or `all`).
- `preferences.lastReadTextIds{}` — maps learning language to last-read text ID.
- `normalizeState()` migrates legacy `lastReadTextId` (singular) to the new map format.
- Book removal, hiding, language switching, and library clear all clean up archive and last-read references.

### Data Safety & Reliability

- **Atomic vocab save** — vocab.json is now written to a temp file first, then atomically renamed, preventing corruption on crash or power loss.
- **Vocab backup recovery** — a `.bak` copy of vocab.json is kept; if the main file is corrupt or missing, the app automatically recovers from backup.
- **Retry on save failures** — save operations retry up to 5 times with backoff on `PermissionError`.
- **Pending save debouncing** — concurrent save requests are coalesced instead of firing in parallel, reducing race conditions.
- **Sync XHR on close** — `flushPendingSave()` uses synchronous XHR when the window is closing, ensuring data is sent before Qt destroys the web view.
- **Server payload validation** — `/__store/save` validates field types before writing, returning clear errors for malformed payloads.
- **Safe SQLite migration** — legacy `texts` table is only dropped after all rows are successfully migrated to filesystem-based storage; partial failures keep the old table.
- **Sync texts ordering** — new text data is written *before* old books are deleted, preventing data loss on crash mid-sync.
- **Savepoint transactions** — `set_prefs` and `set_hidden_books` use SQL savepoints with rollback on failure.
- **`upsert_text` no longer mutates caller's dict** — the original dictionary is preserved; a copy is written to disk.

### Build & Project Cleanup

- Added `dist/` and `.venv/` to `.gitignore`.
- Removed temporary build artifacts: `build/`, `dist/`, `.playwright-mcp/`, `My_Data/`, root `__pycache__/`, `cpp/build/`.

### Code Refactoring & Deduplication

- **SVG icon centralization** — ~200 lines of duplicated inline SVG markup replaced with a single `icon()` helper in `src/web/js/icons.js`. All icons defined once, reused everywhere.
- **Shared utility functions** — `statusLabel()`, `calcStatsPcts()`, `renderCardStat()`, `renderCardCount()` moved from view-specific files to shared modules (`utils.js`, `icons.js`), eliminating 3-way duplication.
- **CSS deduplication** — merged duplicate selectors (`*`, `.book-card`, `.metric-pill`, `.tag`, `dialog`, `.brand span`) removing ~30 lines of redundant CSS.
- **Argos UI template extraction** — ~130 lines of inline CSS in `server.py` moved to standalone `src/web/templates/translator-popup.html`, separating presentation from Python logic.
- **Removed duplicate event handlers** — clipboard fallback and contextmenu prevention were duplicated between `navigation.js` and `shared.js`/`app.js`.
- Net reduction: ~240 lines across 8 files. No functional or visual changes.

### Bug Fixes

- **Book stats not calculated on startup** — restored `loadAllBookTexts()` and `loadAllCustomTextContents()` in `app.js` startup sequence. Library book cards now show correct known/learning/new word percentages immediately without needing to open each book first.
- **Dialogs closing on accidental backdrop click** — removed global backdrop click-to-close listener that accidentally closed dialogs when clicking outside. Now each dialog requires explicit cancel action, and dialogs with unsaved changes (edit book, add/edit word, Argos language selection, move book) show a confirmation dialog with Save / Discard / Cancel options.
- **Edit book dialog too narrow** — increased max-width from 800px to 1000px (95vw) for better usability.

### UX Improvements

- **Unsaved changes protection** — edit book dialog, add/edit word dialog, Argos download language selection, and move book dialog now track dirty state and show a styled confirmation dialog when closing with unsaved changes.
- **Shared dialog-backdrop module** — new `dialog-backdrop.js` module provides reusable `registerUnsavedDialog()` and `showUnsavedConfirm()` functions for dirty-check and confirmation flow.
- **TTS workflow option** — users can enable automatic word pronunciation when navigating focused reader tokens.

### i18n

- Added `unsavedChanges` section (title, message, save, discard, cancel) across all 9 languages.
- Updated Help "What's new" and version text for 0.2.7.5 across all 9 languages.
