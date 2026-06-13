# Word Hunter 0.2.7.4

## Release Notes

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
