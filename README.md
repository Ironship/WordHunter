<p align="center">
  <img src="src/web/favicon.svg" width="128" alt="Word Hunter logo">
</p>

<h1 align="center">Word Hunter</h1>

Word Hunter is a local-first reader, vocabulary trainer, and language-learning
workspace for desktop and Android. The Android version is called Word Hunter
Pocket.

The project is built around one idea: read real texts, click words you want to
learn, keep the context, and review them later without losing control of your
data.

## Project Status

Current release snapshot: `0.3.6.2`.

Active targets:

- Windows and Linux desktop: `Word Hunter`
- Android: `Word Hunter Pocket`

Installers, portable archives, APKs, and AABs are published as GitHub Release
assets, not tracked in the source tree.

Release `0.3.6` focuses on PDF and packaging work: PDF pages can keep their
original background with selectable word overlays, scanned/text-layer spacing is
more reliable, Pocket can zoom and pan PDF pages on Android, and Linux builds now
have Flatpak packaging.

Release `0.3.6.1` is a hotfix refresh for the `0.3.6` line. It rebuilds Windows
packages with the required GNU runtime DLLs, fixes Flatpak/Linux OCR GPU
platform detection, bundles the Flatpak CPU OCR runtime for scanned PDFs, and
makes Flatpak sync folder selection persist only after a successful sync while
honoring XDG config/data directories.

Release `0.3.6.2` collects the follow-up testing fixes for the same line. It
adds the managed Google Drive sync coordinator through bundled rclone with
staged cloud pulls and no remote deletes in the MVP, makes Discover follow the
active learning profile language on desktop and Android while preserving the
selected source, and tightens the Linux/Flatpak GTK titlebar workaround so close
and maximize buttons keep receiving clicks in normal window mode. Interrupted
Google Drive authorization now cleans up partial app-owned rclone remotes and
lets the user retry from the Connect Google Drive button, and transient Google
Drive quota/rate-limit errors during connector setup are retried before the
connector is marked failed. Local/background sync snapshots also keep the
visible cloud connector status instead of briefly falling back to "not
connected" after a successful Google Drive connection.

## What It Includes

- Local-first reading for pasted text, PDFs, EPUB files, URLs, subtitles, and
  library imports.
- Vocabulary states, spaced-repetition review, TTS, keyboard shortcuts, and
  reading progress.
- PDF reading with OCR/text-layer support, page-background overlays, and a clean
  text mode for focused reading.
- Translation and dictionary tools with language-aware handling for modern and
  historical languages.
- Android Pocket layout for mobile reading, review, and PDF zoom/pan.
- Linux Flatpak packaging for local installation and release distribution.
- Optional folder sync for library data, vocabulary, review state, and backups.

## Supported Learning Languages

Word Hunter keeps a separate library and vocabulary profile for each learning
language:

<table>
  <tr>
    <td><img src="src/web/flags/en.svg" width="24" alt="English flag"> English</td>
    <td><img src="src/web/flags/de.svg" width="24" alt="German flag"> German</td>
    <td><img src="src/web/flags/es.svg" width="24" alt="Spanish flag"> Spanish</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/it.svg" width="24" alt="Italian flag"> Italian</td>
    <td><img src="src/web/flags/fr.svg" width="24" alt="French flag"> French</td>
    <td><img src="src/web/flags/pl.svg" width="24" alt="Polish flag"> Polish</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/uk.svg" width="24" alt="Ukrainian flag"> Ukrainian</td>
    <td><img src="src/web/flags/ru.svg" width="24" alt="Russian flag"> Russian</td>
    <td><img src="src/web/flags/ja.svg" width="24" alt="Japanese flag"> Japanese</td>
  </tr>
  <tr>
    <td><img src="src/web/flags/zh.svg" width="24" alt="Chinese flag"> Chinese (Simplified)</td>
    <td><img src="src/web/flags/la.svg" width="24" alt="Latin flag artwork"> Latin</td>
    <td><img src="src/web/flags/grc.svg" width="24" alt="Ancient Greek flag artwork"> Ancient Greek</td>
  </tr>
</table>

Translation, TTS, catalog, and offline-model availability can vary by language
and provider.

## Feature Walkthrough

### Library, Import, and OCR

The library collects imported texts, public-domain books, OCR/PDF entries, and
reading progress in one place. Desktop keeps the full import workflow visible,
including pasted text, ebooks, subtitles, and scanned PDF/OCR imports.

<img src="docs/screenshots/pc-library.png" width="860" alt="Word Hunter desktop library with import panel">

Word Hunter Pocket shows the same kind of library in a phone layout. Pocket is
optimized for reading and review on Android, with a compact card list, large
touch targets, collapsible search filters, and a side import drawer for lighter
mobile imports.

<img src="docs/screenshots/pocket-library.png" width="300" alt="Word Hunter Pocket library">

### Reader, Highlighting, and Word Panel

The reader highlights vocabulary by status directly in the text. Clicking a word
opens the word panel with status buttons, translation, notes, context, dictionary
actions, TTS, image hints, and in-text review controls.

<img src="docs/screenshots/pc-reader.png" width="860" alt="Word Hunter desktop reader with highlighted words and word panel">

Pocket keeps the same reading model, but changes the shape for mobile: bottom
navigation, touch selection, a compact toolbar, and a bottom sheet-style word
panel.

<img src="docs/screenshots/pocket-reader.png" width="300" alt="Word Hunter Pocket reader with word panel">

### Word Base

Every saved word keeps its status, translation, example sentence, review data,
and source context. The word base is the maintenance view for searching,
filtering, editing, exporting, and cleaning vocabulary.

<img src="docs/screenshots/pc-word-base.png" width="860" alt="Word Hunter vocabulary list with statuses, translations, examples, and actions">

### Flashcards and SRS

Flashcards use the same vocabulary records as the reader. Word Hunter supports
spaced repetition, due queues, review history, pronunciation, dictionary
actions, reverse cards, and rating buttons.

<img src="docs/screenshots/pc-flashcards.png" width="860" alt="Word Hunter desktop flashcard review with SRS queue">

Pocket keeps flashcard review usable on a phone, with the card, answer controls,
review heatmap, and queue adapted to the narrow screen.

<img src="docs/screenshots/pocket-flashcards.png" width="300" alt="Word Hunter Pocket flashcard review">

### Graphs and Progress

The graphs view turns vocabulary history into visible progress: total cards, due
reviews, mature cards, active review cards, heatmap activity, and vocabulary
growth levels.

<img src="docs/screenshots/pc-graphs.png" width="860" alt="Word Hunter desktop graphs with vocabulary progress and heatmap">

The same progress view is available in Pocket, so review activity and vocabulary
growth remain visible away from the desktop.

<img src="docs/screenshots/pocket-graphs.png" width="300" alt="Word Hunter Pocket graphs with vocabulary progress and heatmap">

### Desktop and Pocket Sync

Word Hunter is local-first. Desktop and Android can share custom texts, user
books, vocabulary, settings, progress, and imported reading materials through a
user-selected sync folder. The screenshots below show a shared demo library with
vocabulary progress rendered on desktop and Pocket.

| Desktop | Pocket |
| --- | --- |
| <img src="docs/screenshots/pc-library.png" width="420" alt="Word Hunter desktop library with synchronized learning data"> | <img src="docs/screenshots/pocket-library.png" width="220" alt="Word Hunter Pocket library with synchronized learning data"> |

Pocket intentionally keeps heavy import work lighter than desktop. Larger
conversion and OCR work is best done on desktop, then moved to Pocket through
sync.

## Sync and Backups

Word Hunter does not require an account or a central server. The app stores data
locally and can copy changes through a folder chosen by the user.

- Desktop can use a local data folder and an optional sync folder.
- Android keeps local data inside the app and lets the user pick a separate sync
  folder.
- Sync transfers books, vocabulary, settings, progress, and imported reading
  materials.
- Deleted books and words stay deleted after sync instead of returning from an
  older device copy.
- Cloud folders can be delayed. When using Google Drive or similar providers,
  use a dedicated Word Hunter folder and wait until cloud upload/download is
  complete before opening another device.
- Full backup export is useful before testing new sync setups.

## Supported Targets

- Windows desktop
- Linux desktop
- Android Pocket

macOS and iOS are not active targets right now.

## Build From Source

### Requirements

- Rust `1.88` or newer with Cargo.
- Tauri 2 native prerequisites for the desktop platform being built.
- PowerShell when using the bundled `scripts\build.bat` helper on Windows.
- Android SDK, NDK, and JDK for Android Pocket builds.
- OCR runtime/model assets only when preparing desktop OCR support.

### Common Commands

```powershell
.\scripts\build.bat test         # run shared, desktop, and Android frontend tests
.\scripts\build.bat installer    # build outputs\Word.Hunter.Setup.exe
.\scripts\build.bat portable     # build outputs\Word.Hunter.portable.zip
.\scripts\build.bat apk          # build outputs\Word.Hunter.Pocket.debug.apk
.\scripts\build.bat aab          # build outputs\Word.Hunter.Pocket.release.aab
.\scripts\build.bat play         # build signed Google Play AAB
.\scripts\build.bat ocr-runtime  # prepare bundled native PaddleOCR runtime
```

Rust backend tests can also be run directly:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
```

### Flatpak

Linux Flatpak packaging is available through `flatpak-builder`:

```bash
./scripts/build-flatpak.sh
./scripts/install-flatpak-local.sh
```

The script installs missing Flatpak SDK dependencies from Flathub when needed,
builds the manifest in `com.wordhunter.app.yml`, and writes
`outputs/WordHunter.flatpak`. Install from the generated local repo for desktop
testing so software stores can read the local AppStream metadata and icons.
Word Hunter uses the GNOME Flatpak runtime because Tauri depends on
GTK/WebKitGTK; on KDE Plasma the script also installs the Breeze GTK theme
extension when needed so the GTK/WebKit window follows KDE
styling. The Flatpak disables WebKitGTK's DMABUF renderer to avoid known
Wayland renderer crashes on some KDE/Mesa setups while still keeping Wayland
enabled. After changing `src-tauri/Cargo.lock`, refresh the vendored Cargo source
list with:

```bash
./scripts/update-flatpak-cargo-sources.sh
```

The build script writes distributable files to `outputs/`. That directory is
generated output, not source.

## Repository Layout

- `src/web/` - shared frontend application code.
- `src/web/platforms/` - platform-specific frontend styling and behavior.
- `src-tauri/` - Tauri 2 Rust backend, commands, OCR/import logic, and platform
  config.
- `src-tauri/platforms/android/` - Android-specific backend boundary.
- `frontend-tests/` - Node-based frontend and platform tests.
- `docs/` - public documentation and screenshots.
- `.cargo/` - Cargo configuration used by the workspace.
- `scripts/build.bat` - Windows convenience entrypoint for tests and release artifacts.

## Privacy and Data Ownership

Word Hunter is designed as a local-first app:

- No account is required.
- Books, custom texts, vocabulary, progress, and settings are stored locally.
- Sync uses a folder chosen by the user.
- Online requests happen only when the user uses features that need them, such
  as public catalog discovery, dictionary links, online translation, or online
  speech features.
- User data should be backed up before risky sync experiments or before moving
  data folders.

## License

Word Hunter is licensed under `AGPL-3.0-or-later`.

Closed-source commercial derivative use requires a separate written commercial
license. See `COMMERCIAL-LICENSE.md` for details.

## AI USAGE

Yes frontend was writen mostly with AI. I am not frontend developer. I have used those scripts for long time  and I see value for people to use this COMPLETELY FREE and WITHOUT dependency on cloud or paid services like Readlang, Lingq, Babbel or AnkiWeb. If you would love to help then please just use it and put your thoughts. I use it every day myself.
