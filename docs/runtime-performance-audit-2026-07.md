# Runtime reliability and performance audit

Date: 2026-07-27

Scope: Android and desktop startup, local HTTP bridge, durable store, sync,
Reader, PDF/OCR imports, vocabulary indexes, flashcards, TTS, charts, caches,
workers, subprocesses, and lifecycle persistence.

## Release blockers addressed

| Finding | Impact | Resolution |
| --- | --- | --- |
| Compact Android snapshots omitted `pdfOcrPages`, then ordinary saves treated the projection as a deletion | Permanent loss of PDF OCR metadata | Rust now derives the page count from the durable array and restores projected text and PDF fields before merge |
| Missing or temporarily unreadable projected text was silently accepted | A transient cloud-sync read failure could become permanent text loss | Rust now fails the save closed and keeps the recovery journal |
| Full Store snapshot was generated inside the index request | First HTML and the watchdog could both wait behind recovery and full record scans | Index is constant-time again; store load is asynchronous and has a 12 second deadline |
| Bridge and save requests had no deadline | One request could poison autosave, exclusive writes, and graceful close indefinitely | Shared bounded fetch covers response headers and immediate body reads for startup, Store, saves, text loads, and close |
| All native routes shared one blocking 16-worker admission pool | TTS/OCR/sync could starve close, cancel, load, and save | Rust now has non-blocking regular, Store, and control lanes with overload responses |
| Android import cleanup raced newly started imports | Startup cleanup could remove a live import directory | Recovery now completes before the HTTP server exposes import routes; mutations remain under the write guard |
| First FSRS review schedule was overwritten by the Learning transition | Persisted interval and due date disagreed | The scheduler result remains authoritative after status transition |
| TTS used one global boolean for all asynchronous sessions | An old book could resume after a new utterance started | Sessions are generation-scoped, abortable, and Android listeners have terminal cleanup |
| Rust Edge TTS created a runtime and client per request | High setup cost and easy worker-pool saturation | Rust reuses a bounded runtime/client, limits concurrency, uses cancellation-safe non-pooled sockets, and finishes before the 15 second frontend deadline |
| Rust phrase index discarded repeated words, order, and Reader boundaries | False phrase matches and missed real matches | Rust stores only observed vocabulary phrases, preserving sequence and repetition while stopping at punctuation, newlines, and images |

## Performance work completed

| Area | Previous cost | Current behavior |
| --- | --- | --- |
| Library startup | Downloaded and retained every active book body | Normal title/author browsing loads visible cards and the active Reader; a statistics sort explicitly hydrates the complete candidate set |
| Book body memory | Unbounded map across visited profiles | Byte-bounded 48 MiB LRU cache pins the active Reader; retained statistics no longer keep duplicate bodies |
| Library search/filter persistence | Full durable snapshot and render per input | UI-state-only persistence and debounced search rendering |
| Reader page navigation | Full token classification twice plus scan from token zero | Classification/statistics cached by state revision; indexed page boundaries are O(1) |
| Phrase index cache | Unique-word pseudo-sequence and a text-only key produced incorrect or stale matches | Strict cache v4 contains exact observed phrases and fingerprints the active multiword vocabulary keys |
| UI-state writes | A burst queued one disk write per event | One active write loop coalesces changes arriving during a write |
| Edge TTS word playback | Unabortable `Audio` URL request | Bounded fetch, object URL lifecycle, stale-session rejection |

## Open high-priority architecture work

These items require storage/API migrations or platform job protocols. They should
not be hidden inside the release hotfix.

| Priority | Finding | Required direction |
| --- | --- | --- |
| P1 | Full durable save still serializes all profiles and records, journals the full payload, scans records repeatedly, and rewrites comparisons | Make Rust authoritative for incremental domain mutations; journal dirty record keys and cache fingerprints |
| P1 | One global Store mutex covers sync, records, media, and UI state | Move to a Store actor or generation-based transactions; perform remote inventory and hashing outside commit lock |
| P1 | Android PDF import passes full PDF and rendered PNG pages through synchronous base64 JavaScript bridges | Keep `PdfRenderer` in Kotlin, but use file handles and an asynchronous Rust-managed import job with small progress messages |
| P1 | Text and PDF metadata are monolithic records | Split book metadata, text body, PDF page metadata, and media into directly addressable chunks |
| P1 | Android sync cancellation does not propagate into Rust | Add a cancellable job ID/token checked between inventory, merge, and copy batches |
| P1 | Calibre, CT2, `yt-dlp`, `pdftoppm`, GPU probes, and Syncthing setup do not share one deadline-safe process runner | Add a Rust child-process guard that drains pipes, kills, and reaps on deadline/cancellation |
| P1 | Final lifecycle saves can still be interrupted by Android process suspension | Add ordered write revisions in Rust and a bounded Kotlin lifecycle persistence handshake |
| P1 | Portable backup explicitly omits media but destructive clear accepts it | Implement a streamed Rust archive with records, text, media, and a manifest before treating backup as lossless |
| P2 | PDF page reconciliation repeats cumulative offsets and quadratic LCS work | Compute cumulative indexes and bounded alignment in Rust at import/correction time |
| P2 | Graphs repeatedly scan vocabulary and can render unbounded history | Build one aggregate model in a worker, cap date ranges, and downsample scatter data |
| P2 | Translation, Discover, and image search need one latest-only cancellation abstraction | Use bounded external-request queues and generation-scoped results |
| P2 | Worker jobs and several dynamic listeners lack universal supervision | Add worker deadlines/restart and disposable listener scopes |

## Rust ownership boundary

Move to Rust:

- durable vocabulary/book/preference delta operations;
- record cache, fingerprints, journaling, recovery, and generation checks;
- paged Reader indexes and persisted aggregate text statistics;
- phrase occurrence indexes and PDF page reconciliation;
- file-backed import/export jobs, process supervision, and sync cancellation;
- media inventory, hashes, and streamed complete backups.

Keep outside Rust:

- DOM construction, Canvas rendering, touch gestures, and visual virtualization;
- Android Storage Access Framework, `PdfRenderer`, TTS engine, and lifecycle callbacks;
- frontend interaction state, latest-only presentation logic, and user-facing recovery UI.

Moving these UI/platform responsibilities through JSON IPC would add copies and
latency without reducing main-thread rendering work.

## Verification gates

- Rust round-trip test: compact mobile PDF snapshot preserves body and OCR pages.
- Rust failure test: unreadable projected text cannot be overwritten.
- Rust phrase tests: repeated words preserve order and punctuation/newline/image boundaries match the Reader.
- Rust admission tests: route classes and permit saturation/release are covered; a real HTTP overload integration test remains open.
- Frontend FSRS regression test asserts the exact first interval and derives the due date from the recorded review time.
- Frontend behavior tests cover response-body deadlines, strict Rust index schema, vocabulary-dependent cache invalidation, indexed pagination, active-body eviction, lazy statistics sorting, and stale TTS callbacks.
- Source-regex tests for Android/Kotlin ABI constants remain structural checks, not runtime timeout or concurrency tests.
- Full validation after the regression audit: 458 frontend tests and 298 Rust library tests passed.
- Add device benchmarks next for 10k vocabulary entries, 100 books, a 1M-word text, and a 500-page PDF.
